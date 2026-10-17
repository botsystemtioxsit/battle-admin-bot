// Доступ Worker'а к Realtime Database "как админ": OAuth2-токен сервисного
// аккаунта Google (секрет Worker'а FIREBASE_SERVICE_ACCOUNT — JSON-ключ).
//
// Зачем. Раньше Worker доказывал базе "эту запись разрешил я", кладя общий
// секрет (ROLE_GRANT_KEY) прямо в записываемые данные — потому что
// database.rules.json умеет только сравнивать данные с литералом. Но база
// читается всеми, так что ключ на мгновение (между записью и отдельным
// запросом на очистку) был виден любому слушателю базы. Запрос с токеном
// сервисного аккаунта идёт в обход правил (включая .validate), поэтому
// никакой секрет в данные класть не нужно вовсе: ни roleGrantKey, ни
// adminActionKey, ни очистки.
//
// Это не Firebase Auth для пользователей (никакой регистрации и писем) —
// обычный серверный доступ с ключом сервисного аккаунта, бесплатный на Spark.
// Файл — отдельный .mjs, чтобы тот же код мог запускать и CI-самотест
// (scripts/selftest-firebase-admin.mjs) перед выкладкой Worker'а.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = [
  'https://www.googleapis.com/auth/firebase.database',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');
// токен живёт час; обновляем заранее, чтобы запрос не упал на границе
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function bytesToBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function textToBase64Url(text) {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

function pemToPkcs8(pem) {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function parseServiceAccount(raw) {
  let sa = raw;
  if (typeof raw === 'string') {
    // секрет мог попасть сюда с BOM/пробелами или целиком в base64 (google-
    // github-actions/auth принимает оба вида) — принимаем то же самое
    let text = raw.replace(/^\uFEFF/, '').trim();
    if (!text.startsWith('{')) {
      try {
        text = atob(text).replace(/^\uFEFF/, '').trim();
      } catch {
        // не base64 — ниже сработает общая ошибка "это не JSON"
      }
    }
    try {
      sa = JSON.parse(text);
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT: это не JSON');
    }
  }
  if (!sa || typeof sa.client_email !== 'string' || typeof sa.private_key !== 'string' || !sa.private_key.includes('BEGIN PRIVATE KEY')) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT: нужен JSON-ключ сервисного аккаунта (client_email и private_key)');
  }
  return sa;
}

async function signAssertion(sa, nowSec) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = { iss: sa.client_email, scope: SCOPES, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 };
  const signingInput = `${textToBase64Url(JSON.stringify(header))}.${textToBase64Url(JSON.stringify(claims))}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

let cached = null; // { email, token, expiresAt }

// Возвращает действующий access_token для REST-запросов к базе
// (`?access_token=...`). fetchImpl/now — для тестов.
//
// Обмен токена намеренно НЕ делится между параллельными запросами (общий
// "полёт" обмена): в Cloudflare Workers обещание, созданное в одном запросе,
// может не завершиться, если его запрос отменили (клиент закрыл Mini App), и
// тогда все последующие запросы изолята зависли бы на нём. Два параллельных
// обмена на холодном старте безобидны — кэш просто перезапишется.
export async function getAdminAccessToken(rawServiceAccount, { fetchImpl = fetch, now = Date.now } = {}) {
  const sa = parseServiceAccount(rawServiceAccount);
  const nowMs = now();
  const sameAccount = cached && cached.email === sa.client_email;
  if (sameAccount && cached.expiresAt - nowMs > REFRESH_MARGIN_MS) return cached.token;

  try {
    const assertion = await signAssertion(sa, Math.floor(nowMs / 1000));
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      throw new Error(`Google OAuth ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    }
    const data = await res.json();
    if (!data || typeof data.access_token !== 'string') throw new Error('Google OAuth: в ответе нет access_token');
    cached = { email: sa.client_email, token: data.access_token, expiresAt: nowMs + (Number(data.expires_in) || 3600) * 1000 };
    return data.access_token;
  } catch (err) {
    // обновление не удалось, а прежний токен ещё действует (мы обновляем
    // заранее, за 5 минут) — не роняем все записи из-за сбоя Google
    if (sameAccount && cached.expiresAt > nowMs) return cached.token;
    throw err;
  }
}

export function resetAdminTokenCache() {
  cached = null;
}
