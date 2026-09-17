// role-gateway — единственное место, которое умеет по-настоящему проверить
// "этот человек — существующий superadmin" и после этого выдать кому-то
// роль admin/superadmin в Firebase RTDB.
//
// Раньше эту проверку делал клиентский код admin.html: он сам решал, можно
// ли писать роль, и знал секретный ключ, без которого database.rules.json
// такую запись отклоняет. Но admin.html выполняется в браузере — секрет,
// зашитый в его JS, виден любому через DevTools/просмотр исходного кода
// страницы, поэтому такая защита не настоящая (см. переписку/аудит).
//
// Здесь секрет (ROLE_GRANT_KEY) и токен бота (BOT_TOKEN) — переменные
// окружения Worker'а, они физически никогда не попадают ни в один файл,
// который отдаётся браузеру. Единственное, что видит клиент — HTTP-ответ
// "успех/ошибка".
//
// Проверка личности вызывающего идёт через initData — подписанную Telegram
// строку (Telegram.WebApp.initData в мини-приложении), которую подделать
// невозможно, не зная BOT_TOKEN (алгоритм — офиц. документация Telegram
// Bot API, "Validating data received via the Mini App").

const FIREBASE_DB_URL = 'https://zolotaya-kletka-default-rtdb.firebaseio.com';
const ALLOWED_ROLES = new Set(['admin', 'superadmin']);
const MAX_INITDATA_AGE_SECONDS = 5 * 60; // initData даётся один раз на открытие — 5 минут более чем достаточно

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function hmacSha256Hex(keyBytes, message) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256Bytes(keyBytes, message) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

// Возвращает { ok: true, userId } или { ok: false, reason }
async function verifyTelegramInitData(initData, botToken) {
  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: 'initData не парсится' };
  }
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'нет hash в initData' };
  params.delete('hash');

  const pairs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');

  // secret_key = HMAC_SHA256(data=bot_token, key="WebAppData") — см. доку Telegram
  const secretKeyBytes = await hmacSha256Bytes(new TextEncoder().encode('WebAppData'), botToken);
  const computedHash = await hmacSha256Hex(secretKeyBytes, dataCheckString);

  if (computedHash !== hash) return { ok: false, reason: 'подпись не совпала' };

  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > MAX_INITDATA_AGE_SECONDS) {
    return { ok: false, reason: 'initData устарела' };
  }

  let user;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    return { ok: false, reason: 'user не парсится' };
  }
  if (!user || !user.id) return { ok: false, reason: 'нет user.id в initData' };

  return { ok: true, userId: String(user.id) };
}

async function getRole(userId) {
  const res = await fetch(`${FIREBASE_DB_URL}/users/${encodeURIComponent(userId)}/role.json`);
  if (!res.ok) return null;
  return res.json();
}

async function grantRole(env, requesterId, targetUserId, newRole) {
  const patchRes = await fetch(`${FIREBASE_DB_URL}/users/${encodeURIComponent(targetUserId)}.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: newRole, roleGrantKey: env.ROLE_GRANT_KEY }),
  });
  if (!patchRes.ok) {
    throw new Error(`Firebase PATCH ${patchRes.status}: ${await patchRes.text()}`);
  }
  // ключ был нужен только чтобы протолкнуть запись через database.rules.json —
  // сразу убираем его, в профиле ему делать нечего
  await fetch(`${FIREBASE_DB_URL}/users/${encodeURIComponent(targetUserId)}/roleGrantKey.json`, {
    method: 'DELETE',
  }).catch(() => {});
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/grant-role' || request.method !== 'POST') {
      return jsonResponse({ error: 'not found' }, 404);
    }

    if (!env.BOT_TOKEN || !env.ROLE_GRANT_KEY) {
      return jsonResponse({ error: 'Worker не настроен (нет секретов)' }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'битый JSON' }, 400);
    }

    const { initData, targetUserId, newRole } = body || {};
    if (!initData || !targetUserId || !newRole) {
      return jsonResponse({ error: 'нужны initData, targetUserId, newRole' }, 400);
    }
    if (!ALLOWED_ROLES.has(newRole)) {
      return jsonResponse({ error: `newRole должен быть одним из: ${[...ALLOWED_ROLES].join(', ')}` }, 400);
    }

    const verified = await verifyTelegramInitData(initData, env.BOT_TOKEN);
    if (!verified.ok) {
      return jsonResponse({ error: 'Telegram initData не прошла проверку: ' + verified.reason }, 401);
    }

    const requesterRole = await getRole(verified.userId);
    if (requesterRole !== 'superadmin') {
      return jsonResponse({ error: 'Выдавать admin/superadmin может только существующий superadmin' }, 403);
    }

    try {
      await grantRole(env, verified.userId, String(targetUserId), newRole);
    } catch (err) {
      return jsonResponse({ error: 'Firebase отказал: ' + err.message }, 502);
    }

    return jsonResponse({ ok: true });
  },
};
