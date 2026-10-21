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
// Здесь ключ сервисного аккаунта (FIREBASE_SERVICE_ACCOUNT) и токен бота (BOT_TOKEN) — переменные
// окружения Worker'а, они физически никогда не попадают ни в один файл,
// который отдаётся браузеру. Единственное, что видит клиент — HTTP-ответ
// "успех/ошибка".
//
// Проверка личности вызывающего идёт через initData — подписанную Telegram
// строку (Telegram.WebApp.initData в мини-приложении), которую подделать
// невозможно, не зная BOT_TOKEN (алгоритм — офиц. документация Telegram
// Bot API, "Validating data received via the Mini App").

import { getAdminAccessToken, resetAdminTokenCache } from './firebase-admin.mjs';

const FIREBASE_DB_URL = 'https://zolotaya-kletka-default-rtdb.firebaseio.com';
const GITHUB_OWNER = 'botsystemtioxsit';
const DATA_REPO = 'battle-data-admin-bot';
const CODE_REPOS = new Set(['index.html', 'battle-admin-bot']);
// Жёсткий allowlist путей снимков в приватном репозитории: единственная защита
// от того, чтобы через /delete-backup и /delete-backups удаляли (а через
// /download-backup, где такой же регэксп записан на месте, читали)
// произвольные файлы репозитория — workflow'ы, чужие папки, всё остальное.
// Проверяется через isBackupPathAllowed ниже, одним и тем же кодом для
// одиночного и пакетного удаления.
const BACKUP_PATH_RE = /^(code-backups\/(index\.html|battle-admin-bot)\/[A-Za-z0-9._-]+\.zip|db-snapshots\/[A-Za-z0-9._-]+\.json)$/;
// Сколько снимков можно удалить одним вызовом /delete-backups и сколько раз
// ghDeleteFiles пробует заново, если ветку main успели сдвинуть (см. там).
const MAX_DELETE_PATHS = 100;
const DELETE_COMMIT_ATTEMPTS = 3;
const ALLOWED_ROLES = new Set(['admin', 'superadmin']);
const ALLOWED_STATUSES = new Set(['active', 'restricted', 'banned']);
// Кто считается "персоналом" для Worker'а. 'moderator' сюда НЕ входит: это
// легаси-значение (панель новых модераторов не назначает, в базе их нет), а
// запись role:'moderator' в users/<id> клиенту разрешена правилами — значит,
// любой игрок мог бы сам стать "персоналом" и банить кого угодно.
const STAFF_ROLES = new Set(['admin', 'superadmin']);
const MAX_INITDATA_AGE_SECONDS = 5 * 60; // initData даётся один раз на открытие — 5 минут более чем достаточно

// Дублирует ELO_K/ELO_BASELINE и стоимость лиг из index.html (LEAGUES,
// computeEloDelta) — см. комментарий у finishMatch ниже про то, почему это
// вообще нужно продублировать на сервере, а не просто доверять клиенту.
// Обе версии названия первых двух лиг (обычная и "чистый режим") ведут на
// одну и ту же ставку — battle.league хранит то имя, которое было
// показано именно тому игроку, который встал в очередь, а у него могла
// быть своя настройка чистого режима.
const ELO_K = 32;
const ELO_BASELINE = 1000;
const REFEREE_STARS_REWARD = 5;
const LEAGUE_BY_NAME = {};
function addLeague(names, stake, penalty) {
  for (const n of names) LEAGUE_BY_NAME[n] = { stake, penalty };
}
addLeague(['Сын шлюхи', 'Новичок'], 10, 0);
addLeague(['Говно из-под коня', 'Слабак'], 25, 25);
addLeague(['Отброс общества'], 50, 50);
addLeague(['Шавка подзаборная'], 100, 100);
addLeague(['Уважаемый тролль'], 200, 200);
addLeague(['Батя троллей'], 400, 400);
addLeague(['Рабовладелец'], 800, 800);

function getMonthKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

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

// Путь снимка допустим, только если это строка без ".." и целиком подходит
// под BACKUP_PATH_RE. Точка в имени разрешена (2026-10-16.zip), поэтому ".."
// проверяется отдельно — регэксп сам пропустил бы, например, "a..zip".
function isBackupPathAllowed(path) {
  return typeof path === 'string' && !path.includes('..') && BACKUP_PATH_RE.test(path);
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

// Проверка через доверенное устройство (users/$uid/trustedDevices/$deviceKey)
// — альтернатива initData, чтобы бэкапы/роли работали не только внутри
// настоящей Telegram-сессии, но и из desktop-приложения/обычного браузера
// (проект кроссплатформенный, initData там принципиально недоступен — это
// не Telegram Mini App).
//
// База читается целиком всеми (database.rules.json: .read: true) и пишется
// всеми (.write: true), поэтому в ней нельзя хранить ничего, что одновременно
// является доказательством личности. Раньше ключом записи был сам сырой
// deviceId — и любой, кто просто прочитал users/<id>/trustedDevices (или
// devicePairings/deviceTrustRequests, куда deviceId тоже попадал), получал
// готовое "доказательство" чужого устройства и мог вызывать /grant-role,
// /restore-database, /restore-code от имени суперадмина. Теперь:
//  - сырой deviceId живёт только в localStorage браузера и приходит сюда
//    только в теле HTTPS-запроса — в базу он не пишется нигде;
//  - в базе лежит deviceKey = sha256(deviceId): по нему deviceId не
//    восстановить (128 бит случайности), а сам по себе он ничего не даёт;
//  - запись считается доверенной, только если в ней есть sig =
//    HMAC(секрет Worker'а, uid|deviceKey|expiresAt). Такую запись умеет
//    создавать только этот Worker (POST /trust-device); подделать её прямой
//    записью в открытую базу нельзя — подпись не угадать, а expiresAt в неё
//    входит, так что срок доверия тоже не продлить.
// Записи старого формата (ключ — сырой deviceId, без sig) не проходят —
// они были публично прочитаны, устройства надо одобрить заново.
const DEVICE_KEY_RE = /^[0-9a-f]{64}$/;
const MAX_TRUST_DURATION_MS = 10 * 365 * 24 * 60 * 60 * 1000;

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Ключ подписи выводится из BOT_TOKEN с отдельным контекстом — отдельный
// секрет заводить не нужно (wrangler secret put не требуется), а подпись
// доверия при этом не пересекается ни с чем, что подписывается BOT_TOKEN
// напрямую (initData).
async function deviceTrustSig(env, uid, deviceKey, expiresAt) {
  const keyBytes = await hmacSha256Bytes(new TextEncoder().encode(env.BOT_TOKEN), 'battle-role-gateway/device-trust/v1');
  return hmacSha256Hex(keyBytes, `${uid}|${deviceKey}|${expiresAt || 0}`);
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyDeviceTrust(env, telegramId, deviceId) {
  if (!telegramId || !deviceId) return { ok: false, reason: 'нужны telegramId и deviceId' };
  if (typeof deviceId !== 'string' || deviceId.length < 16 || deviceId.length > 128) {
    return { ok: false, reason: 'некорректный deviceId' };
  }
  const uid = String(telegramId);
  const deviceKey = await sha256Hex(deviceId);
  const res = await fetch(`${FIREBASE_DB_URL}/users/${encodeURIComponent(uid)}/trustedDevices/${deviceKey}.json`);
  if (!res.ok) return { ok: false, reason: 'Firebase недоступен' };
  const val = await res.json();
  if (!val) return { ok: false, reason: 'устройство не доверено' };
  if (typeof val.sig !== 'string') return { ok: false, reason: 'устройство не доверено (запись старого формата — нужно одобрить заново)' };
  const expected = await deviceTrustSig(env, uid, deviceKey, val.expiresAt);
  if (!safeEqualHex(val.sig, expected)) return { ok: false, reason: 'подпись доверия не совпала' };
  // Временное доверие (см. "Запросы на устройства" в admin.html) —
  // expiresAt задаётся при одобрении, null/отсутствует значит "навсегда".
  // Проверяем именно здесь, а не только на клиенте: клиентская проверка —
  // это просто UX (не пускает на устаревший экран раньше времени), а этот
  // Worker — единственное место, которое реально решает, можно ли трогать
  // GITHUB_TOKEN.
  if (val.expiresAt && val.expiresAt <= Date.now()) {
    return { ok: false, reason: 'доверие устройству истекло' };
  }
  return { ok: true, userId: uid, via: 'device', expiresAt: val.expiresAt || null };
}

// Какой бот у Worker'а в BOT_TOKEN (публичное имя и id, сам токен наружу не
// уходит). Нужен для диагностики: если панель открыта через другого бота, подпись
// initData не сойдётся, и без этого понять причину нельзя. Кэш на 10 минут.
let botInfoCache = { token: null, at: 0, info: null };
async function getBotInfo(env) {
  const now = Date.now();
  if (botInfoCache.token === env.BOT_TOKEN && now - botInfoCache.at < 10 * 60 * 1000) return botInfoCache.info;
  let info;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getMe`, { signal: AbortSignal.timeout(5000) });
    const data = await res.json().catch(() => null);
    if (data && data.ok && data.result) {
      info = { valid: true, username: data.result.username || null, id: data.result.id || null };
    } else if (data && data.ok === false) {
      // Telegram явно отказал (401 Unauthorized / 404 Not Found для неверного
      // токена) — токен неверный или отозван
      info = { valid: false, error: String(data.description || data.error_code || 'отказ').slice(0, 80) };
    } else {
      info = { valid: null }; // ответ не от Bot API (сбой/блокировка по пути) — неизвестно
    }
  } catch {
    info = { valid: null }; // не дозвонились — неизвестно
  }
  botInfoCache = { token: env.BOT_TOKEN, at: now, info };
  return info;
}

// Общая точка входа для проверки личности: initData, если она есть
// (сильнее — подпись Telegram), иначе deviceId (см. выше). `via` говорит,
// каким из двух способов личность подтверждена.
async function verifyIdentity(body, env) {
  if (body.initData) {
    const verified = await verifyTelegramInitData(body.initData, env.BOT_TOKEN);
    if (verified.ok) return { ...verified, via: 'telegram' };
    if (verified.reason === 'подпись не совпала') {
      // самая частая причина — панель открыта через бота, чей токен не у Worker'а
      const bot = await getBotInfo(env);
      if (bot.username) verified.reason += ` (Worker проверяет подпись бота @${bot.username} — панель нужно открывать через него)`;
      else if (bot.valid === false) verified.reason += ` (Telegram не принимает токен бота, заданный у Worker'а: ${bot.error || 'отказ'}; токен отозван или задан неверно)`;
    }
    return verified;
  }
  if (body.telegramId && body.deviceId) return verifyDeviceTrust(env, body.telegramId, body.deviceId);
  return { ok: false, reason: 'нужны initData либо telegramId+deviceId' };
}

// Единственное место, где в trustedDevices появляется доверенная запись.
// Писать её вызывающий напрямую в базу не может — без sig запись не
// считается доверенной (см. verifyDeviceTrust).
async function writeTrustedDevice(env, uid, deviceKey, { label, durationMs, approvedBy }) {
  const expiresAt = durationMs ? Date.now() + durationMs : null;
  const sig = await deviceTrustSig(env, uid, deviceKey, expiresAt);
  const res = await dbWrite(env, `/users/${encodeURIComponent(uid)}/trustedDevices/${deviceKey}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, pairedAt: Date.now(), expiresAt, approvedBy, sig }),
  });
  if (!res.ok) throw new Error(`Firebase PUT ${res.status}: ${await res.text()}`);
}

async function getRole(userId) {
  const res = await fetch(`${FIREBASE_DB_URL}/users/${encodeURIComponent(userId)}/role.json`);
  if (!res.ok) return null;
  return res.json();
}

// Одно поле игрока. Запись users/<id> целиком тяжёлая (в ней аватарка
// base64, друзья, статистика), а большинству проверок нужен один ключ
// (role, playerId) — читаем только его.
async function getUserField(telegramId, field) {
  const res = await fetch(`${FIREBASE_DB_URL}/users/${encodeURIComponent(telegramId)}/${field}.json`);
  if (!res.ok) return null;
  return res.json();
}

// Существует ли users/<id>. ?shallow=true отдаёт только имена полей, без
// значений, — для проверки наличия записи этого хватает.
async function userExists(telegramId) {
  const res = await fetch(`${FIREBASE_DB_URL}/users/${encodeURIComponent(telegramId)}.json?shallow=true`);
  if (!res.ok) return false;
  return (await res.json()) != null;
}

// Кто для Worker'а superadmin. Если в конфиге задан OWNER_IDS (список
// telegram-id через запятую, см. wrangler.toml), то ТОЛЬКО они: роль в базе
// (users/<id>/role) — данные, которые любой может стереть (DELETE
// пропускает .validate) или, до исправления правил, подделать, поэтому на неё
// нельзя опираться как на единственное основание для выдачи ролей, полной
// перезаписи базы и бэкапов (GITHUB_TOKEN). Без OWNER_IDS — как раньше, по роли.
function ownerIds(env) {
  return new Set(String(env.OWNER_IDS || '').split(',').map((x) => x.trim()).filter(Boolean));
}

function isSuperadmin(env, userId, role) {
  const owners = ownerIds(env);
  return owners.size > 0 ? owners.has(String(userId)) : role === 'superadmin';
}

function isStaff(env, userId, role) {
  return isSuperadmin(env, userId, role) || STAFF_ROLES.has(role);
}

// Бэкапы/восстановление — ТОЛЬКО superadmin. Раньше можно было делегировать
// конкретному admin через users/<id>/permissions/backups, но правила
// разрешают записать это поле кому угодно: любой игрок выдавал себе право и
// через /restore-code (файлы берутся из запроса!) подменял код игры и панели
// токеном Worker'а. В панели такого права у admin нет (его нет в
// PERMISSION_DEFS), в базе его не было ни у кого.
function hasBackupsAccess(env, userId, role) {
  return isSuperadmin(env, userId, role);
}

// playerId (вида "PLR-XXXXXX") — внутренний игровой id, отдельный от
// telegramId/ключа в users/ — вся логика боя (battles/matches, судейство)
// оперирует именно им, поэтому нужен обратный поиск по нему.
async function getUserByPlayerId(playerId) {
  const url = `${FIREBASE_DB_URL}/users.json?orderBy=${encodeURIComponent('"playerId"')}&equalTo=${encodeURIComponent('"' + playerId + '"')}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const keys = Object.keys(data || {});
  if (!keys.length) return null;
  return { key: keys[0], user: data[keys[0]] || {} };
}

// Раньше Worker доказывал базе "запись разрешил я", кладя общий секрет
// (ROLE_GRANT_KEY) в саму запись и стирая его вторым запросом. База читается
// всеми, поэтому слушатель видел ключ в этот промежуток (а анонимный /health
// мог запустить такую запись по запросу). Теперь все записи идут с OAuth-токеном
// сервисного аккаунта (секрет FIREBASE_SERVICE_ACCOUNT): правила для него не
// действуют, никакой секрет в данные не попадает, очищать нечего. Старого
// режима нет намеренно — без секрета Worker отвечает 500, а не молча
// возвращается к схеме с утечкой.

// URL записи в базу; `path` — от корня, с `.json` (например '/users/1.json').
async function dbWriteUrl(env, path) {
  const token = await getAdminAccessToken(env.FIREBASE_SERVICE_ACCOUNT);
  return `${FIREBASE_DB_URL}${path}?access_token=${encodeURIComponent(token)}`;
}

// Запись в базу. На 401/403 один раз сбрасываем кэш токена и повторяем: ключ
// сервисного аккаунта могли ротировать, токен — отозвать; без этого все
// записи падали бы до конца часа.
async function dbWrite(env, path, init) {
  const res = await fetch(await dbWriteUrl(env, path), init);
  if (res.status === 401 || res.status === 403) {
    resetAdminTokenCache();
    return fetch(await dbWriteUrl(env, path), init);
  }
  return res;
}

// Идентификатор, который подставляется в путь к базе (id пользователя, боя).
// С токеном сервисного аккаунта правила не действуют, поэтому путь не должен
// строиться из непроверенного текста: ни слэшей, ни точек, ни спецсимволов.
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

async function grantRole(env, requesterId, targetUserId, newRole) {
  const patchRes = await dbWrite(env, `/users/${encodeURIComponent(targetUserId)}.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: newRole }),
  });
  if (!patchRes.ok) {
    throw new Error(`Firebase PATCH ${patchRes.status}: ${await patchRes.text()}`);
  }
}

// Бан/разбан чужого аккаунта — то же самое зеркало, что и grantRole, но для
// users/$uid/status. Нужен отдельно от прямой записи из admin.html, потому что
// для аккаунтов с owners-записью (см. index.html, Anonymous Auth)
// database.rules.json не пускает чужой auth.uid менять status — а запись
// токеном сервисного аккаунта правила обходит.
async function setStatus(env, targetUserId, newStatus, restrictedUntil) {
  const patchRes = await dbWrite(env, `/users/${encodeURIComponent(targetUserId)}.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: newStatus, restrictedUntil: restrictedUntil ?? null }),
  });
  if (!patchRes.ok) {
    throw new Error(`Firebase PATCH ${patchRes.status}: ${await patchRes.text()}`);
  }
}

// Записывает итог боя — раньше это делал напрямую клиент СУДЬИ (см.
// refereeDeclareWinner/finishMatch в index.html): один клиент пишет
// points/stats ОБОИМ игрокам плюс себе (награда за судейство) — то есть
// это ЕДИНСТВЕННЫЙ путь в игре, где один аккаунт напрямую меняет чужие
// points/starsBalance. Именно поэтому эти поля раньше не были защищены
// через owners-привязку (см. переписку) — наивная проверка "менять может
// только владелец" сразу сломала бы начисление очков в каждом бою. Теперь
// это не наивная проверка: сервер сам проверяет через initData, что
// пишущий — это действительно назначенный судья этого конкретного боя
// (battle.refereeId), и сам пересчитывает начисление (лига/ELO) по данным
// из базы, а не доверяет числам от клиента — иначе судья мог бы просто
// прислать любые pointsAwarded.
//
// Не переносит: сжигание билета-множителя (window.consumeMultiplierTicket
// в index.html) — если у победителя есть активный билет, здесь он пока не
// учитывается (множитель всегда 1). Осознанное упрощение первой версии,
// не критично для защиты — просто чуть менее щедрое начисление в редком
// случае, а не дыра.
async function finishMatch(env, refereePlayerId, matchId, winnerSide) {
  const battleRes = await fetch(`${FIREBASE_DB_URL}/battles/${encodeURIComponent(matchId)}.json`);
  if (!battleRes.ok) throw new Error(`Firebase GET ${battleRes.status}`);
  const battle = await battleRes.json();
  if (!battle) throw new Error('Бой не найден');
  if (battle.status === 'finished') throw new Error('Бой уже завершён');
  // Записи боя и игроков в базе пишет кто угодно, поэтому "я судья этого боя"
  // этим не доказать (см. README, известные ограничения). Хотя бы явную
  // подделку отсекаем: судья не может быть участником боя, а бой — с самим собой.
  if (battle.hostId && battle.hostId === battle.guestId) throw new Error('Некорректный бой');
  if (refereePlayerId === battle.hostId || refereePlayerId === battle.guestId) throw new Error('Судья не может быть участником боя');
  if (battle.refereeId !== refereePlayerId) throw new Error('Вы не назначены судьёй этого боя');

  const winnerId = winnerSide === 'host' ? battle.hostId : battle.guestId;
  const loserId = winnerSide === 'host' ? battle.guestId : battle.hostId;
  if (!winnerId || !loserId) throw new Error('В бою не хватает участника');

  // Четыре чтения друг от друга не зависят (каждое — отдельный круг до базы),
  // поэтому идут одновременно: профили победителя, проигравшего и судьи плюс
  // лайки зрителей.
  const [winnerRec, loserRec, refRec, likesRes] = await Promise.all([
    getUserByPlayerId(winnerId),
    getUserByPlayerId(loserId),
    getUserByPlayerId(refereePlayerId),
    fetch(`${FIREBASE_DB_URL}/battles/${encodeURIComponent(matchId)}/audienceLikes.json`),
  ]);
  if (!winnerRec || !loserRec) throw new Error('Не найден профиль игрока');

  const pointsAwarded = {};
  if (battle.league && LEAGUE_BY_NAME[battle.league]) {
    const { stake, penalty } = LEAGUE_BY_NAME[battle.league];
    pointsAwarded[winnerId] = stake;
    pointsAwarded[loserId] = -penalty;
  } else {
    const winnerRating = Number(winnerRec.user.points ?? ELO_BASELINE);
    const loserRating = Number(loserRec.user.points ?? ELO_BASELINE);
    const expectedWinner = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
    const delta = Math.round(ELO_K * (1 - expectedWinner));
    pointsAwarded[winnerId] = delta;
    pointsAwarded[loserId] = -delta;
  }

  const likes = (await likesRes.json().catch(() => null)) || {};
  const audienceVotes = {};
  if (battle.hostId) audienceVotes[battle.hostId] = likes.host || 0;
  if (battle.guestId) audienceVotes[battle.guestId] = likes.guest || 0;

  const finishedAt = Date.now();
  const currentMonth = getMonthKey();
  const update = {
    [`battles/${matchId}/status`]: 'finished',
    [`battles/${matchId}/winnerId`]: winnerId,
    [`battles/${matchId}/loserId`]: loserId,
    [`battles/${matchId}/pointsAwarded`]: pointsAwarded,
    [`battles/${matchId}/trophyMultiplier`]: 1,
    [`matches/${matchId}/status`]: 'finished',
    [`matches/${matchId}/winnerId`]: winnerId,
    [`matches/${matchId}/loserId`]: loserId,
    [`matches/${matchId}/refereeId`]: refereePlayerId,
    [`matches/${matchId}/pointsAwarded`]: pointsAwarded,
    [`matches/${matchId}/audienceVotes`]: audienceVotes,
    [`matches/${matchId}/finishedAt`]: finishedAt,
  };

  for (const [playerId, rec] of [[winnerId, winnerRec], [loserId, loserRec]]) {
    const u = rec.user;
    const delta = Number(pointsAwarded[playerId] || 0);
    const likeDelta = Number(audienceVotes[playerId] || 0);
    const stats = u.stats || {};
    const monthlyBase = u.monthlyPeriod === currentMonth ? Number(u.monthlyPoints || 0) : 0;
    update[`users/${rec.key}/points`] = Math.max(0, Number(u.points || 0) + delta);
    update[`users/${rec.key}/monthlyPoints`] = monthlyBase + delta;
    update[`users/${rec.key}/monthlyPeriod`] = currentMonth;
    update[`users/${rec.key}/stats/battles`] = Number(stats.battles || 0) + 1;
    update[`users/${rec.key}/stats/wins`] = Number(stats.wins || 0) + (winnerId === playerId ? 1 : 0);
    update[`users/${rec.key}/stats/losses`] = Number(stats.losses || 0) + (loserId === playerId ? 1 : 0);
    update[`users/${rec.key}/stats/audienceLikes`] = Number(stats.audienceLikes || 0) + likeDelta;
  }

  if (refRec) {
    const u = refRec.user;
    update[`users/${refRec.key}/stats/refereeBattles`] = Number(u.stats?.refereeBattles || 0) + 1;
    update[`users/${refRec.key}/starsBalance`] = Number(u.starsBalance || 0) + REFEREE_STARS_REWARD;
  }

  const patchRes = await dbWrite(env, '/.json', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
  if (!patchRes.ok) {
    throw new Error(`Firebase PATCH ${patchRes.status}: ${await patchRes.text()}`);
  }


  return { winnerId, loserId, pointsAwarded, audienceVotes, trophyMultiplier: 1 };
}

// Полное восстановление базы из снимка (battle-data-admin-bot, вкладка
// «Восстановление» → «Восстановить базу»). Пишется одним PUT в корень токеном
// сервисного аккаунта: правила для него не действуют, поэтому снимок кладётся
// как есть — раньше приходилось подмешивать в записи users/<id> служебные ключи
// и потом стирать их (и они на время оказывались в открытой базе).
async function restoreDatabase(env, snapshot) {
  const payload = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const putRes = await dbWrite(env, '/.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!putRes.ok) {
    throw new Error(`Firebase PUT ${putRes.status}: ${await putRes.text()}`);
  }
}

// ===== Заявки на вход: уведомление в Telegram и кнопки «Разрешить/Отклонить» =====
//
// Заявку кладёт в users/<id>/loginRequests страница, откуда входят (игра или
// админ-панель; поле app: 'game' | 'admin' — только для текста сообщения,
// никаких прав оно не даёт, как и device — их пишет кто угодно). Страница
// сразу дёргает /login-notify, Worker пишет владельцу аккаунта от имени бота
// (BOT_TOKEN) с кнопками. Нажатия кнопок Telegram присылает вебхуком на
// /telegram-webhook — раньше их ловил Telegram Serverless игрового бота, но
// сообщение уходит от бота-терминала (токен в BOT_TOKEN), а нажатие всегда
// приходит тому боту, который отправил сообщение, — поэтому «Разрешить» молча
// не срабатывало. Теперь получатель — сам Worker (см. ensureTelegramWebhook).

const TELEGRAM_WEBHOOK_PATH = '/telegram-webhook';
// Кнопка «Открыть админ-панель» в /start и /admin (тот же адрес, что и в
// telegram-serverless/handlers/message.js)
const ADMIN_PANEL_URL = 'https://botsystemtioxsit.github.io/battle-admin-bot/public/admin.html';
// Заявка живёт 5 минут на стороне страницы; с запасом на разницу часов
const LOGIN_REQUEST_TTL_MS = 10 * 60 * 1000;
const LOGIN_APPS = {
  game: { emoji: '🎮', name: 'ИГРУ' },
  admin: { emoji: '🛠', name: 'АДМИН-ПАНЕЛЬ' },
  videochat: { emoji: '📹', name: 'ВИДЕОЧАТ' },
};

// Метка устройства попадает в сообщение бота — только короткий безопасный
// текст (буквы любого языка, цифры, пробел и . _ ( ) , / -), не произвольная строка
function safeDeviceLabel(value) {
  const s = String(value || '');
  return /^[\p{L}\p{N} ._(),\/-]{1,40}$/u.test(s) ? s : 'неизвестное устройство';
}

// app пишет кто угодно — берём только известные значения (иначе 'constructor'
// и прочие ключи прототипа дали бы мусор в тексте)
function loginApp(req) {
  const key = req && req.app;
  return key === 'game' || key === 'admin' || key === 'videochat' ? LOGIN_APPS[key] : null;
}

function loginRequestTitle(req) {
  const app = loginApp(req);
  return app ? `Вход в ${app.name}` : 'Вход в аккаунт';
}

function loginRequestText(req) {
  const app = loginApp(req);
  const head = app ? `${app.emoji} Запросили вход в ${app.name}` : '🔑 Запросили вход в твой аккаунт';
  return `${head}\nУстройство: ${safeDeviceLabel(req && req.device)}\n\nРазрешить вход? Если это не ты — нажми «Отклонить».`;
}

function loginRequestKeyboard(requestId) {
  return { inline_keyboard: [[{ text: '✅ Разрешить', callback_data: 'la:' + requestId }, { text: '❌ Отклонить', callback_data: 'ld:' + requestId }]] };
}

async function tgApi(env, method, payload, timeoutMs = 8000) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return await res.json().catch(() => ({ ok: false, description: 'ответ не JSON' }));
  } catch (err) {
    return { ok: false, description: String((err && err.message) || err) };
  }
}

// Секрет вебхука выводится из BOT_TOKEN — новых секретов заводить не нужно.
// Telegram присылает его в заголовке X-Telegram-Bot-Api-Secret-Token на каждый
// запрос: без него /telegram-webhook не принимает ничего (иначе любой мог бы
// слать «нажатия кнопок» от чужого имени).
async function telegramWebhookSecret(env) {
  return hmacSha256Hex(new TextEncoder().encode(String(env.BOT_TOKEN)), 'telegram-webhook-v1');
}

function constantTimeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

// Делает Worker получателем обновлений бота. Бот может иметь только один
// вебхук: прежние получатели (функция на Vercel, long polling, Telegram
// Serverless) отключаются — поэтому /start, /admin, /help обрабатываются тут же.
// setWebhook идемпотентен, так что повторный вызов безвреден; в пределах одного
// экземпляра Worker'а он делается не чаще раза в 30 минут.
let webhookEnsured = { key: null, at: 0 };
async function ensureTelegramWebhook(env, origin) {
  const key = origin + '|' + env.BOT_TOKEN;
  if (webhookEnsured.key === key && Date.now() - webhookEnsured.at < 30 * 60 * 1000) return true;
  const data = await tgApi(env, 'setWebhook', {
    url: origin + TELEGRAM_WEBHOOK_PATH,
    secret_token: await telegramWebhookSecret(env),
    allowed_updates: ['message', 'callback_query'],
    max_connections: 10,
  }, 5000);
  if (!data.ok) {
    console.error('setWebhook не удался:', data.description);
    return false;
  }
  webhookEnsured = { key, at: Date.now() };
  return true;
}

// Для /health: чей вебхук у бота (адрес целиком не отдаём — в чужом он может
// содержать секрет, только хост)
async function getWebhookSummary(env, origin) {
  const data = await tgApi(env, 'getWebhookInfo', {}, 5000);
  if (!data.ok || !data.result) return { ours: null, error: String(data.description || 'нет ответа').slice(0, 80) };
  const info = data.result;
  let host = null;
  try { host = info.url ? new URL(info.url).host : null; } catch { host = null; }
  return {
    ours: info.url === origin + TELEGRAM_WEBHOOK_PATH,
    host,
    pending: info.pending_update_count || 0,
    lastError: info.last_error_message ? String(info.last_error_message).slice(0, 120) : null,
  };
}

async function notifyLoginRequest(env, telegramId, requestId, origin) {
  const reqUrl = `${FIREBASE_DB_URL}/users/${encodeURIComponent(telegramId)}/loginRequests/${encodeURIComponent(requestId)}.json`;
  const req = await (await fetch(reqUrl)).json();
  if (!req || req.status !== 'pending') throw new Error('заявка не найдена или уже обработана');
  if (Date.now() - (req.requestedAt || 0) > 5 * 60 * 1000) throw new Error('заявка устарела');
  if (req.notifiedAt) return { alreadyNotified: true };
  await fetch(reqUrl, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifiedAt: Date.now() }) });
  // получатель кнопок — этот Worker; без этого «Разрешить» ничего не сделает
  await ensureTelegramWebhook(env, origin);
  const data = await tgApi(env, 'sendMessage', {
    chat_id: telegramId,
    text: loginRequestText(req),
    reply_markup: loginRequestKeyboard(requestId),
  });
  // 403 = человек ни разу не запускал бота или заблокировал его — не ошибка
  // вызывающего, заявку всё равно можно подтвердить в игре/панели
  if (!data.ok) return { sent: false };
  return { sent: true };
}

// Нажатие «Разрешить/Отклонить». Кто нажал, знаем от Telegram (query.from.id —
// запрос подписан секретом вебхука), поэтому путь берётся из него, а не из
// callback_data: подтвердить можно только заявки на свой собственный аккаунт.
async function handleLoginCallback(env, query) {
  const answer = (text) => tgApi(env, 'answerCallbackQuery', { callback_query_id: query.id, text });
  const m = /^(la|ld):([A-Za-z0-9_-]{1,128})$/.exec(String(query.data || ''));
  const fromId = String((query.from && query.from.id) || '');
  if (!m || !/^\d+$/.test(fromId)) { await answer(); return; }
  const reqUrl = `${FIREBASE_DB_URL}/users/${fromId}/loginRequests/${m[2]}.json`;
  let req;
  try {
    req = await (await fetch(reqUrl)).json();
  } catch {
    await answer('Не удалось связаться с базой, попробуй ещё раз.');
    return;
  }
  const age = Date.now() - Number((req && req.requestedAt) || 0);
  let resultText;
  if (!req || req.status !== 'pending' || !(Math.abs(age) <= LOGIN_REQUEST_TTL_MS)) {
    resultText = 'Запрос уже обработан или устарел.';
    await answer(resultText);
  } else {
    const approved = m[1] === 'la';
    const patch = await dbWrite(env, `/users/${fromId}/loginRequests/${m[2]}.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: approved ? 'approved' : 'denied' }),
    });
    if (!patch.ok) {
      await answer('Не получилось записать ответ, попробуй ещё раз.');
      return;
    }
    resultText = `${approved ? '✅' : '⛔'} ${loginRequestTitle(req)} ${approved ? 'разрешён' : 'отклонён'}.\nУстройство: ${safeDeviceLabel(req.device)}`;
    await answer(approved ? 'Вход разрешён.' : 'Вход отклонён.');
  }
  if (query.message && query.message.chat && query.message.message_id) {
    // editMessageText без reply_markup убирает кнопки
    await tgApi(env, 'editMessageText', { chat_id: query.message.chat.id, message_id: query.message.message_id, text: resultText });
  }
}

// Команды бота. Раньше их обслуживали функция на Vercel / long polling /
// Telegram Serverless (api/telegram-webhook.js, bot/index.js,
// telegram-serverless/handlers/message.js) — теперь тот же набор живёт тут,
// потому что вебхук у бота один.
// Код подключения устройства (devicePairings/<код>): 6 символов без 0/O/1/I, как в randomPairingCode
// панели и лаунчера. Человек вписывает код прямо в чат с ботом — это и есть подтверждение: кто
// написал, определяет Telegram (message.from.id), а не текст сообщения, поэтому подключить
// устройство можно только к СВОЕМУ аккаунту.
const PAIRING_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

async function handlePairingCode(env, message, code) {
  const chatId = message.chat.id;
  const say = (text) => tgApi(env, 'sendMessage', { chat_id: chatId, text });
  const fromId = String((message.from && message.from.id) || '');
  if (!/^\d+$/.test(fromId)) return;
  let pairing;
  try {
    pairing = await (await fetch(`${FIREBASE_DB_URL}/devicePairings/${code}.json`)).json();
  } catch {
    await say('Не удалось связаться с базой, попробуй ещё раз.');
    return;
  }
  const fresh = pairing && Math.abs(Date.now() - Number(pairing.requestedAt || 0)) <= LOGIN_REQUEST_TTL_MS;
  if (!pairing || pairing.status !== 'pending' || !fresh || typeof pairing.deviceKey !== 'string' || !DEVICE_KEY_RE.test(pairing.deviceKey)) {
    await say('Не нашёл такой код — он мог устареть (живёт 5 минут) или быть набран с ошибкой. Запроси новый в приложении.');
    return;
  }
  if (!(await userExists(fromId))) {
    await say('Для этого Telegram-аккаунта нет профиля в игре — сначала открой игру.');
    return;
  }
  const label = safeDeviceLabel(pairing.device);
  try {
    // сначала подписанная запись о доверии, и только потом «approved»: устройство входит сразу по этому статусу
    await writeTrustedDevice(env, fromId, pairing.deviceKey, { label, durationMs: null, approvedBy: fromId });
    const patch = await dbWrite(env, `/devicePairings/${code}.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved', telegramId: fromId, approvedAt: Date.now() }),
    });
    if (!patch.ok) throw new Error(`Firebase PATCH ${patch.status}`);
  } catch (err) {
    console.error('pairing code:', err && err.message);
    await say('Что-то пошло не так, попробуй ещё раз.');
    return;
  }
  await say(`✅ Устройство подключено: ${label}.\n\nЕсли это были не вы — отзовите его в админ-панели («Аккаунт» → «Отозвать»).`);
}


// ===== ВидеоЧат: комнаты Telegram-чатов (репозиторий videochat) =====
// Бота добавляют в группу. Администратор группы пишет /connect — Worker САМ проверяет
// у Telegram (getChatMember), что это администратор или создатель чата, и кладёт заявку в
// videochat/communityRequests/<chatId>; владельцу проекта (OWNER_IDS) приходит сообщение со
// ссылкой на панель, где он подтверждает заявку (там же появляются комната и суб-админ).
// /call в подключённой группе присылает кнопку входа и код комнаты. Состоит ли человек в чате,
// страница видеочата спрашивает у Worker'а (/vc-membership): ответ даёт Telegram, а не база.
const VIDEOCHAT_URL = 'https://botsystemtioxsit.github.io/videochat/';
const VC_MEMBER_STATUSES = new Set(['creator', 'administrator', 'member']);
// Mini App ВидеоЧата, зарегистрированное у @BotFather: «имя_бота/короткое_имя» (/newapp), например
// troll_battle_Terminal_bot/video, либо просто «имя_бота» — если приложение настроено как главное
// (Configure Mini App) (wrangler.toml → VIDEOCHAT_MINIAPP). Пока не задано (или задано криво) —
// кнопки ведут по обычной ссылке на страницу, она откроется в браузере Телеграма.
function videochatMiniAppLink(env) {
  const v = String((env && env.VIDEOCHAT_MINIAPP) || '').trim();
  return /^[A-Za-z0-9_]{5,64}(\/[A-Za-z0-9_]{3,64})?$/.test(v) ? `https://t.me/${v}` : null;
}
// Кнопка входа в комнату чата: в группе web_app-кнопки Телеграм не разрешает, поэтому только ссылка
function videochatRoomUrl(env, key) {
  const mini = videochatMiniAppLink(env);
  return mini ? `${mini}?startapp=${encodeURIComponent(key)}` : `${VIDEOCHAT_URL}?room=${encodeURIComponent(key)}`;
}

// Telegram гарантирует getChatMember про ДРУГИХ людей только боту-администратору группы. Поэтому для
// администраторов есть запасной путь — getChatAdministrators (он доступен любому боту в группе); для
// обычных участников без прав бота ответа не будет (null) — об этом пишем человеку явно.
async function chatMemberStatus(env, chatId, userId) {
  const data = await tgApi(env, 'getChatMember', { chat_id: chatId, user_id: Number(userId) }, 6000);
  if (data.ok && data.result) {
    const r = data.result;
    if (r.status === 'restricted') return r.is_member ? 'member' : 'left';
    return r.status;
  }
  const admins = await tgApi(env, 'getChatAdministrators', { chat_id: chatId }, 6000);
  if (admins.ok && Array.isArray(admins.result)) {
    const hit = admins.result.find((m) => m && m.user && String(m.user.id) === String(userId));
    if (hit) return hit.status === 'creator' ? 'creator' : 'administrator';
  }
  return null;
}

// Администратор ли бот в этой группе (нужно, чтобы проверять обычных участников)
async function botIsAdminIn(env, chatId) {
  const info = await getBotInfo(env);
  if (!info || !info.id) return null;
  const data = await tgApi(env, 'getChatMember', { chat_id: chatId, user_id: Number(info.id) }, 6000);
  if (!data.ok || !data.result) return null;
  return data.result.status === 'administrator' || data.result.status === 'creator';
}

async function dbReadPublic(path) {
  const res = await fetch(`${FIREBASE_DB_URL}${path}.json`, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`Firebase GET ${res.status}`);
  return res.json();
}

// Команда вида «/call» или «/call@ИмяБота»; чужому боту (/call@other_bot) не отвечаем
async function commandForMe(env, text) {
  const first = String(text || '').trim().split(/\s+/)[0];
  const m = /^\/([A-Za-z_]+)(?:@([A-Za-z0-9_]+))?$/.exec(first);
  if (!m) return null;
  if (m[2]) {
    const info = await getBotInfo(env);
    if (!info || !info.username || info.username.toLowerCase() !== m[2].toLowerCase()) return null;
  }
  return m[1].toLowerCase();
}

async function handleGroupMessage(env, message) {
  const chat = message.chat;
  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup') || typeof message.text !== 'string') return;
  const cmd = await commandForMe(env, message.text);
  if (cmd !== 'connect' && cmd !== 'call' && cmd !== 'videochat' && cmd !== 'help') return;
  const key = String(chat.id);
  if (!SAFE_ID_RE.test(key)) return;
  const say = (text, extra) => tgApi(env, 'sendMessage', { chat_id: chat.id, text, ...(extra || {}) });
  const title = String(chat.title || 'Чат').slice(0, 60);

  if (cmd === 'help') {
    await say('Видеозвонки для этого чата.\n\n/connect — подключить чат (только администратор чата; заявку подтверждает владелец проекта)\n/call — открыть видеокомнату чата\n\nЧтобы всё работало, этот бот должен быть администратором группы (никакие права ему не нужны).');
    return;
  }

  let community = null;
  try { community = await dbReadPublic(`/videochat/communities/${encodeURIComponent(key)}`); } catch { await say('Не удалось связаться с базой, попробуйте ещё раз.'); return; }

  if (cmd === 'call' || cmd === 'videochat') {
    if (!community || community.status !== 'active') {
      await say('Этот чат ещё не подключён к ВидеоЧату. Администратор чата может отправить /connect.');
      return;
    }
    await say(`📹 Видеокомната «${String(community.title || title).slice(0, 60)}»\nКод комнаты: ${String(community.joinCode || '—')}`, {
      reply_markup: { inline_keyboard: [[{ text: '📹 Войти в комнату', url: videochatRoomUrl(env, key) }]] },
    });
    return;
  }

  // /connect
  const fromId = String((message.from && message.from.id) || '');
  if (!/^\d+$/.test(fromId)) return;
  const status = await chatMemberStatus(env, chat.id, fromId);
  if (status !== 'creator' && status !== 'administrator') {
    await say('Подключить чат может только его администратор.');
    return;
  }
  if (community && community.status) {
    await say('Этот чат уже подключён. Участники могут открыть видеокомнату командой /call.');
    return;
  }
  let existing = null;
  try { existing = await dbReadPublic(`/videochat/communityRequests/${encodeURIComponent(key)}`); } catch { /* считаем, что заявки нет */ }
  if (existing && existing.status === 'pending') {
    await say('Заявка на подключение уже отправлена — ждём подтверждения владельца проекта.');
    return;
  }
  const from = message.from || {};
  const requestedBy = {
    id: fromId,
    name: String([from.first_name, from.last_name].filter(Boolean).join(' ') || 'Без имени').slice(0, 60),
    username: from.username ? String(from.username).slice(0, 40) : null,
  };
  const put = await dbWrite(env, `/videochat/communityRequests/${encodeURIComponent(key)}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: key, title, requestedBy, at: Date.now(), status: 'pending' }),
  });
  if (!put.ok) { await say('Не удалось отправить заявку, попробуйте позже.'); return; }
  for (const owner of ownerIds(env)) {
    if (!/^\d+$/.test(owner)) continue;
    await tgApi(env, 'sendMessage', {
      chat_id: owner,
      text: `📹 Заявка на подключение чата к ВидеоЧату\nЧат: «${title}»\nОт: ${requestedBy.name}${requestedBy.username ? ' (@' + requestedBy.username + ')' : ''}\n\nОткрой панель → ВидеоЧат → Сообщества: там можно одобрить или отклонить.`,
      reply_markup: { inline_keyboard: [[{ text: '🛠 Открыть админ-панель', web_app: { url: `${ADMIN_PANEL_URL}?v=${Date.now()}` } }]] },
    });
  }
  const botAdmin = await botIsAdminIn(env, chat.id);
  await say('✅ Заявка отправлена владельцу проекта. Когда её подтвердят, в этом чате заработает команда /call — она откроет видеокомнату.'
    + (botAdmin === false ? '\n\n⚠️ Сделайте этого бота администратором группы (права не нужны) — иначе он не сможет проверять, кто состоит в чате, и участники не смогут войти в комнату.' : ''));
}

// Страница видеочата перед входом спрашивает, состоит ли человек в Telegram-чате этой комнаты.
async function checkVideochatMembership(env, body) {
  const key = String((body && body.communityKey) || '');
  const userId = String((body && body.userId) || '');
  if (!SAFE_ID_RE.test(key) || !/^\d+$/.test(userId)) return { ok: false, error: 'Неверный запрос.' };
  const community = await dbReadPublic(`/videochat/communities/${encodeURIComponent(key)}`);
  if (!community || community.status !== 'active') return { ok: false, error: 'Комната не найдена или отключена.' };
  if (ownerIds(env).has(userId)) return { ok: true };
  const status = await chatMemberStatus(env, community.tgChatId != null ? community.tgChatId : key, userId);
  if (status === null) return { ok: false, error: 'Не удалось проверить участие в чате. Администратор группы должен сделать бота @troll_battle_Terminal_bot администратором группы (права ему не нужны).' };
  if (!VC_MEMBER_STATUSES.has(status)) return { ok: false, error: 'Вы не состоите в этом Telegram-чате.' };
  return { ok: true };
}


// ===== Экосистема TIOXSIT: «хаб» бота и его профиль в Telegram =====
// Терминал — единая точка входа во все наши продукты: игра, ВидеоЧат, лаунчер, админ-панель. Здесь же список
// команд (меню у поля ввода), краткое и полное описание бота: Worker выставляет их сам (ensureBotProfile),
// так что правка в @BotFather позже может быть перезаписана — менять нужно здесь.
const GAME_BOT_URL = 'https://t.me/troll_battle_bot';
const LAUNCHER_URL = 'https://github.com/botsystemtioxsit/launcher/releases/latest';

const BOT_COMMANDS_PRIVATE = [
  { command: 'start', description: 'Главное меню и все наши проекты' },
  { command: 'apps', description: 'Все проекты экосистемы TIOXSIT' },
  { command: 'video', description: 'Открыть ВидеоЧат' },
  { command: 'game', description: 'Открыть Тролль-Баттл' },
  { command: 'launcher', description: 'Скачать TIOXSIT Launcher для Windows' },
  { command: 'admin', description: 'Админ-панель (для команды)' },
  { command: 'requests', description: 'Ожидающие запросы на вход' },
  { command: 'help', description: 'Помощь' },
];
const BOT_COMMANDS_GROUP = [
  { command: 'connect', description: 'Подключить чат к ВидеоЧату (администратор чата)' },
  { command: 'call', description: 'Открыть видеокомнату этого чата' },
  { command: 'help', description: 'Помощь по ВидеоЧату' },
];
const BOT_SHORT_DESCRIPTION = 'Терминал экосистемы TIOXSIT: Тролль-Баттл, ВидеоЧат, лаунчер. Входы по заявкам, подключение чатов.';
const BOT_DESCRIPTION = 'Терминал экосистемы TIOXSIT — общий вход во все наши проекты.\n\n🎮 Тролль-Баттл — голосовые баттлы\n📹 ВидеоЧат — видеокомнаты для Telegram-чатов\n🚀 TIOXSIT Launcher — установка и обновление приложений\n\nЗдесь подтверждаются входы в аккаунт и подключаются чаты к ВидеоЧату. Нажмите «Start», чтобы увидеть всё.';

function ecosystemMessage() {
  const text = [
    '🌐 Экосистема TIOXSIT — все наши проекты связаны одним аккаунтом.',
    '',
    '🎮 Тролль-Баттл — голосовые баттлы с рейтингом, кланами и ивентами (@troll_battle_bot).',
    '📹 ВидеоЧат — видеокомнаты для Telegram-чатов: стабильные звонки, свои админы, мут голосованием участников.',
    '🚀 TIOXSIT Launcher — программа для Windows: ставит и обновляет наши приложения.',
    '🛠 Админ-панель — управление проектом (для команды).',
    '🤖 Терминал (этот бот) — подтверждает входы и подключает Telegram-чаты к ВидеоЧату.',
    '',
    'Все команды — в меню слева от поля ввода или /help.',
  ].join('\n');
  const stamp = Date.now();
  return {
    text,
    reply_markup: {
      inline_keyboard: [
        [{ text: '📹 ВидеоЧат', web_app: { url: `${VIDEOCHAT_URL}?v=${stamp}` } }, { text: '🎮 Тролль-Баттл', url: GAME_BOT_URL }],
        [{ text: '🚀 Лаунчер для Windows', url: LAUNCHER_URL }, { text: '🛠 Админ-панель', web_app: { url: `${ADMIN_PANEL_URL}?v=${stamp}` } }],
      ],
    },
  };
}

// Профиль бота: команды (меню), описания, кнопка меню = список команд. Идемпотентно; не чаще раза в 6 часов на
// экземпляр Worker'а (первое сообщение боту или /health после выкладки применяют всё сразу).
let botProfileEnsured = { key: null, at: 0 };
async function ensureBotProfile(env) {
  const key = String(env.BOT_TOKEN);
  if (botProfileEnsured.key === key && Date.now() - botProfileEnsured.at < 6 * 60 * 60 * 1000) return;
  botProfileEnsured = { key, at: Date.now() }; // отметка сразу: параллельные запросы не дублируют работу
  const calls = [
    ['setMyCommands', { commands: BOT_COMMANDS_PRIVATE, scope: { type: 'default' } }],
    ['setMyCommands', { commands: BOT_COMMANDS_PRIVATE, scope: { type: 'all_private_chats' } }],
    ['setMyCommands', { commands: BOT_COMMANDS_GROUP, scope: { type: 'all_group_chats' } }],
    ['setMyShortDescription', { short_description: BOT_SHORT_DESCRIPTION }],
    ['setMyDescription', { description: BOT_DESCRIPTION }],
    ['setChatMenuButton', { menu_button: { type: 'commands' } }],
  ];
  const results = await Promise.all(calls.map(([method, payload]) => tgApi(env, method, payload, 6000)));
  const failed = results.map((r, i) => (r && r.ok ? null : calls[i][0] + ': ' + String((r && r.description) || 'нет ответа').slice(0, 80))).filter(Boolean);
  if (failed.length) {
    botProfileEnsured = { key, at: Date.now() - 6 * 60 * 60 * 1000 + 10 * 60 * 1000 }; // что-то не прошло — повторим через 10 минут, а не на каждом сообщении
    console.error('ensureBotProfile:', failed.join('; '));
  }
}

async function handleBotMessage(env, message) {
  if (message && message.chat && message.chat.type !== 'private') { await handleGroupMessage(env, message); return; }
  if (!message || !message.chat || message.chat.type !== 'private' || typeof message.text !== 'string') return;
  const chatId = message.chat.id;
  const pairingCode = message.text.trim().toUpperCase();
  if (PAIRING_CODE_RE.test(pairingCode)) {
    await handlePairingCode(env, message, pairingCode);
    return;
  }
  const command = message.text.trim().split(/\s+/)[0].split('@')[0];
  if (command === '/apps' || command === '/projects') {
    await tgApi(env, 'sendMessage', { chat_id: chatId, ...ecosystemMessage() });
  } else if (command === '/game') {
    await tgApi(env, 'sendMessage', {
      chat_id: chatId,
      text: '🎮 Тролль-Баттл — голосовые баттлы: соперник, судья, зрители, рейтинг, кланы и ивенты. Играть — в боте @troll_battle_bot.',
      reply_markup: { inline_keyboard: [[{ text: '🎮 Открыть Тролль-Баттл', url: GAME_BOT_URL }]] },
    });
  } else if (command === '/launcher') {
    await tgApi(env, 'sendMessage', {
      chat_id: chatId,
      text: '🚀 TIOXSIT Launcher — программа для Windows: вход в аккаунт, установка, обновление и запуск наших приложений (Тролль-Баттл, ВидеоЧат, админ-панель).',
      reply_markup: { inline_keyboard: [[{ text: '🚀 Скачать лаунчер', url: LAUNCHER_URL }]] },
    });
  } else if (command === '/video' || command === '/videochat') {
    // в личном чате web_app-кнопка разрешена: ВидеоЧат откроется внутри Телеграма, вход — по Telegram-аккаунту
    await tgApi(env, 'sendMessage', {
      chat_id: chatId,
      text: '📹 ВидеоЧат — видеозвонки для ваших Telegram-чатов. Комнаты подключённых чатов появятся в списке; в группе их открывает команда /call.',
      reply_markup: { inline_keyboard: [[{ text: '📹 Открыть ВидеоЧат', web_app: { url: `${VIDEOCHAT_URL}?v=${Date.now()}` } }]] },
    });
  } else if (command === '/start') {
    await tgApi(env, 'sendMessage', { chat_id: chatId, ...ecosystemMessage() });
  } else if (command === '/admin') {
    await tgApi(env, 'sendMessage', {
      chat_id: chatId,
      text: 'Открой панель управления БАТТЛ. Доступ проверяется по твоей роли в базе — если её ещё не выдали, страница сама покажет «доступ запрещён».',
      reply_markup: { inline_keyboard: [[{ text: '🛠 Открыть админ-панель', web_app: { url: `${ADMIN_PANEL_URL}?v=${Date.now()}` } }]] },
    });
  } else if (command === '/help') {
    await tgApi(env, 'sendMessage', {
      chat_id: chatId,
      text: 'Терминал экосистемы TIOXSIT.\n\n/start — главное меню и все наши проекты\n/apps — все проекты экосистемы\n/video — открыть ВидеоЧат\n/game — открыть Тролль-Баттл\n/launcher — скачать TIOXSIT Launcher\n/admin — админ-панель (для команды)\n/requests — ожидающие запросы на вход\n\nКод устройства из приложения (6 символов) просто отправь сюда сообщением — устройство подключится к твоему аккаунту.\n\nКогда кто-то запрашивает вход в твой аккаунт (в игре, в ВидеоЧате или в панели), бот пишет сюда с кнопками «Разрешить» и «Отклонить».\n\nВидеозвонки для Telegram-чатов: добавь бота в группу и сделай его администратором (права не нужны), администратор группы пишет там /connect, потом любой участник — /call.',
    });
  } else if (command === '/requests') {
    const fromId = String((message.from && message.from.id) || '');
    if (!/^\d+$/.test(fromId)) return;
    const all = (await (await fetch(`${FIREBASE_DB_URL}/users/${fromId}/loginRequests.json`)).json()) || {};
    const pending = Object.keys(all).filter((k) => /^[A-Za-z0-9_-]{1,128}$/.test(k) && all[k] && all[k].status === 'pending' && Math.abs(Date.now() - Number(all[k].requestedAt || 0)) <= 5 * 60 * 1000);
    if (!pending.length) {
      await tgApi(env, 'sendMessage', { chat_id: chatId, text: 'Нет ожидающих запросов на вход.' });
      return;
    }
    for (const k of pending.slice(0, 10)) {
      await tgApi(env, 'sendMessage', { chat_id: chatId, text: loginRequestText(all[k]), reply_markup: loginRequestKeyboard(k) });
    }
  }
}

async function handleTelegramUpdate(env, update) {
  if (update && update.callback_query) {
    try {
      await handleLoginCallback(env, update.callback_query);
    } catch (err) {
      // сбой Google (токен сервисного аккаунта), сети и т.п.: человек не должен
      // остаться с бесконечным «часиками» на кнопке и без объяснения
      console.error('login callback:', err && err.message);
      await tgApi(env, 'answerCallbackQuery', { callback_query_id: update.callback_query.id, text: 'Что-то пошло не так, попробуй ещё раз.' });
    }
  } else if (update && update.message) {
    await handleBotMessage(env, update.message);
  }
  // профиль бота (команды, описание) обновляем уже после ответа человеку
  try { await ensureBotProfile(env); } catch (err) { console.error('ensureBotProfile:', err && err.message); }
}

async function ghApi(path, token, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      // GitHub отклоняет запросы без User-Agent 403'кой ("Request forbidden
      // by administrative rules") — браузерный fetch подставляет его сам,
      // а fetch внутри Cloudflare Worker'а нет, поэтому без этой строки
      // все вызовы отсюда были обречены падать именно так.
      'User-Agent': 'battle-role-gateway',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`${path} -> ${res.status}: ${body}`);
    // код ответа отдельно от текста — ghDeleteFiles по нему отличает «ветку
    // успели сдвинуть» (422/409) от остальных отказов, не разбирая сообщение
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

// Листинг снимков (code-backups/*, db-snapshots) — battle-data-admin-bot
// теперь ПРИВАТНЫЙ репозиторий, анонимный Contents API его больше не
// отдаёт. 404 (папки ещё нет) — это не ошибка, просто пустой список.
async function ghListDir(env, path) {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${DATA_REPO}/contents/${path}?ref=main`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'battle-role-gateway' },
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub Contents API ${res.status}: ${await res.text().catch(() => '')}`);
  const items = await res.json();
  return items
    .filter((i) => i.type === 'file')
    .map((i) => ({ name: i.name, size: i.size }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

// Содержимое одного снимка (для кнопки "Скачать" в панели и для
// restore-database) — тот же приватный репозиторий, тот же Contents API,
// но с Accept: application/vnd.github.raw+json — GitHub отдаёт сырые байты
// файла прямо в теле ответа вместо JSON с base64.
async function ghDownloadFile(env, path) {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${DATA_REPO}/contents/${path}?ref=main`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github.raw+json', 'User-Agent': 'battle-role-gateway' },
  });
  if (!res.ok) throw new Error(`GitHub Contents API ${res.status}: ${await res.text().catch(() => '')}`);
  return res;
}

// Удаление одного снимка (кнопка "Удалить" в списке бэкапов — старые
// снимки со временем становятся бесполезны, а место в репозитории не
// резиновое). Contents API на DELETE требует текущий sha файла — GitHub
// не даёт удалить вслепую, sha защищает от гонки с параллельным изменением
// того же файла, поэтому сначала GET, потом DELETE с этим sha.
async function ghDeleteFile(env, path) {
  const getRes = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${DATA_REPO}/contents/${path}?ref=main`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'battle-role-gateway' },
  });
  // Удаление — идемпотентная операция: если файла уже нет (двойной клик
  // по кнопке, устаревший список на экране после чужого удаления), это не
  // ошибка, а ровно тот результат, которого добивался вызывающий — файла
  // не существует.
  if (getRes.status === 404) return;
  if (!getRes.ok) throw new Error(`GitHub Contents API ${getRes.status}: ${await getRes.text().catch(() => '')}`);
  const meta = await getRes.json();
  const delRes = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${DATA_REPO}/contents/${path}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'battle-role-gateway',
    },
    body: JSON.stringify({ message: `Удаление старого снимка: ${path}`, sha: meta.sha, branch: 'main' }),
  });
  if (!delRes.ok) throw new Error(`GitHub Contents API ${delRes.status}: ${await delRes.text().catch(() => '')}`);
}

// Пакетное удаление снимков (кнопка «Удалить выбранные» в списке бэкапов) —
// ОДНИМ коммитом через Git Data API. Звать /delete-backup по разу на файл нельзя
// по двум причинам. Первая — лимит Cloudflare Workers Free: 50 подзапросов
// (fetch) на один вызов Worker'а, а ghDeleteFile тратит на файл два (GET + DELETE),
// так что на полсотне снимков вызов падал бы с "Too many subrequests". Вторая —
// каждый DELETE через Contents API это отдельный коммит в main, и параллельные
// удаления ломаются о 409 (каждый хочет сдвинуть одну и ту же ветку). Здесь
// число подзапросов постоянное, сколько бы файлов ни удалялось: ref → коммит →
// дерево (узнать, какие пути реально есть) → новое дерево → коммит → сдвиг
// ветки, то есть 6 на попытку и не больше 18 на все DELETE_COMMIT_ATTEMPTS.
//
// Новое дерево строится от base_tree с записями sha:null — так GitHub убирает
// именно эти файлы и не трогает остальное (в отличие от restoreCode, которому
// нужен полный заменяющий снимок без base_tree). sha:null на несуществующий
// путь GitHub отвергает, поэтому существование проверяем сами по рекурсивному
// дереву, а не вслепую.
//
// Идемпотентно, как и ghDeleteFile: пути, которых уже нет (двойной клик,
// устаревший список на экране), не ошибка, а попадают в missing; если нет ни
// одного — коммит вообще не создаётся. Если пока мы работали, ветку сдвинул
// workflow бэкапа (он пушит в main раз в сутки), PATCH без force отклонится с
// 422/409 — тогда всё повторяется с чтения ref, уже поверх свежей ветки, до
// DELETE_COMMIT_ATTEMPTS раз. Возвращает { deleted, missing } — реально
// удалённые и уже отсутствовавшие пути (в порядке, в котором их передали).
async function ghDeleteFiles(env, paths) {
  const repo = `/repos/${GITHUB_OWNER}/${DATA_REPO}`;
  const wanted = [...new Set(paths)];
  const jsonReq = (body, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  for (let attempt = 1; attempt <= DELETE_COMMIT_ATTEMPTS; attempt++) {
    const refData = await ghApi(`${repo}/git/ref/heads/main`, env.GITHUB_TOKEN);
    const headSha = refData.object.sha;
    const headCommit = await ghApi(`${repo}/git/commits/${headSha}`, env.GITHUB_TOKEN);
    const baseTreeSha = headCommit.tree.sha;
    const baseTree = await ghApi(`${repo}/git/trees/${baseTreeSha}?recursive=1`, env.GITHUB_TOKEN);
    // GitHub обрезает слишком большое рекурсивное дерево и честно пишет об
    // этом — по неполному списку нельзя ни решать «файла нет», ни удалять
    if (baseTree.truncated) {
      throw new Error('дерево репозитория слишком большое — GitHub отдал его не целиком, удалять вслепую нельзя');
    }
    // только файлы (blob): если по такому пути в репозитории окажется папка,
    // это не снимок — трогать её нельзя, путь уйдёт в missing
    const existing = new Set((baseTree.tree || []).filter((e) => e.type === 'blob').map((e) => e.path));
    const present = wanted.filter((p) => existing.has(p));
    const missing = wanted.filter((p) => !existing.has(p));
    if (!present.length) return { deleted: [], missing };

    const newTree = await ghApi(`${repo}/git/trees`, env.GITHUB_TOKEN, jsonReq({
      base_tree: baseTreeSha,
      tree: present.map((path) => ({ path, mode: '100644', type: 'blob', sha: null })),
    }));
    // в сообщении — первые 10 путей, остальные числом: при 100 снимках оно не раздувается
    const shown = present.slice(0, 10).join(', ');
    const rest = present.length > 10 ? ` … и ещё ${present.length - 10}` : '';
    const newCommit = await ghApi(`${repo}/git/commits`, env.GITHUB_TOKEN, jsonReq({
      message: `Удаление снимков (${present.length} шт.): ${shown}${rest}`,
      tree: newTree.sha,
      parents: [headSha],
    }));
    try {
      await ghApi(`${repo}/git/refs/heads/main`, env.GITHUB_TOKEN, jsonReq({ sha: newCommit.sha, force: false }, 'PATCH'));
    } catch (err) {
      // 422 (не fast-forward) / 409: main сдвинули между нашим чтением и
      // записью. Наш коммит остаётся висеть без ветки — безвредно, GitHub
      // его соберёт сам; читаем main заново и повторяем.
      if (err.status !== 422 && err.status !== 409) throw err;
      if (attempt === DELETE_COMMIT_ATTEMPTS) {
        throw new Error(`ветку main меняли прямо во время удаления, после ${DELETE_COMMIT_ATTEMPTS} попыток ничего не удалено — можно повторить`);
      }
      continue;
    }
    return { deleted: present, missing };
  }
}

// Запускает оба workflow бэкапа battle-data-admin-bot немедленно (кнопка
// "Сделать бэкап сейчас"). Раньше это делал клиент напрямую, с GitHub PAT,
// вставленным в браузере (см. переписку/аудит) — токен лежал в localStorage
// и был виден через devtools кому угодно, кто физически сидит за тем же
// компьютером. Теперь токен (GITHUB_TOKEN) — секрет только этого Worker'а,
// клиент передаёт лишь initData, и Worker сам проверяет superadmin ровно
// так же, как перед restoreDatabase ниже.
async function triggerBackupNow(env) {
  await Promise.all(['code-backup.yml', 'db-snapshot.yml'].map((workflow) =>
    ghApi(`/repos/${GITHUB_OWNER}/${DATA_REPO}/actions/workflows/${workflow}/dispatches`, env.GITHUB_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main' }),
    })
  ));
}

// Восстановление кода index.html/battle-admin-bot из снимка
// (battle-data-admin-bot, вкладка "Восстановление" → "Восстановить код").
// Клиент по-прежнему сам скачивает zip и распаковывает его через JSZip (это
// не требует секрета — публичное чтение), но сам git-коммит (blob → tree →
// commit → перевод ветки main) теперь делает Worker с GITHUB_TOKEN, а не
// браузер с PAT из localStorage. files — [{ path, base64 }], уже
// подготовленные клиентом из распакованного архива.
// base64 -> сырые байты. atob здесь безопасен (Cloudflare Workers его
// поддерживают как стандартный global), нужен только для попытки
// распознать текст ниже — сам base64 в блоб для бинарных файлов уходит
// как есть, без промежуточного перекодирования.
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Пытается прочитать байты как валидный UTF-8 текст без NUL — если
// получилось, файл точно текстовый и его можно положить в дерево как есть
// (см. ниже, зачем это вообще нужно).
function tryDecodeUtf8Text(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return text.includes('\u0000') ? null : text;
}

async function restoreCode(env, repo, files) {
  if (!CODE_REPOS.has(repo)) throw new Error('Неизвестный репозиторий: ' + repo);
  if (!Array.isArray(files) || !files.length) throw new Error('Пустой список файлов');

  const refData = await ghApi(`/repos/${GITHUB_OWNER}/${repo}/git/ref/heads/main`, env.GITHUB_TOKEN);
  const latestCommitSha = refData.object.sha;

  // Cloudflare Worker ограничивает число исходящих запросов за один вызов
  // (subrequests) — раньше здесь был один POST /git/blobs НА КАЖДЫЙ файл
  // снимка, и уже на полусотне файлов (весь код-репозиторий — это как раз
  // столько) Worker падал с "Too many subrequests by single Worker
  // invocation", не дойдя даже до сборки дерева. Git Trees API умеет
  // принимать содержимое текстового файла прямо в записи дерева (поле
  // content вместо sha) — GitHub создаёт блоб сам, без отдельного запроса
  // сюда. Поэтому отдельный blob-запрos теперь нужен только для файлов,
  // которые не получилось прочитать как чистый UTF-8-текст (картинки и
  // прочий бинарник) — в этом репозитории таких единицы, а не полсотни.
  const tree = [];
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || typeof file.base64 !== 'string') {
      throw new Error('Некорректная запись файла в снимке');
    }
    const text = tryDecodeUtf8Text(base64ToBytes(file.base64));
    if (text !== null) {
      tree.push({ path: file.path, mode: '100644', type: 'blob', content: text });
      continue;
    }
    const blob = await ghApi(`/repos/${GITHUB_OWNER}/${repo}/git/blobs`, env.GITHUB_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: file.base64, encoding: 'base64' }),
    });
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const newTree = await ghApi(`/repos/${GITHUB_OWNER}/${repo}/git/trees`, env.GITHUB_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tree }),
  });
  const newCommit = await ghApi(`/repos/${GITHUB_OWNER}/${repo}/git/commits`, env.GITHUB_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Восстановление из бэкапа battle-data-admin-bot`,
      tree: newTree.sha,
      parents: [latestCommitSha],
    }),
  });
  await ghApi(`/repos/${GITHUB_OWNER}/${repo}/git/refs/heads/main`, env.GITHUB_TOKEN, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: newCommit.sha, force: false }),
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // Диагностика для админ-панели ("Система" → блок "role-gateway") —
    // отдаёт только true/false, реальные значения секретов наружу никогда
    // не попадают. Ничего не пишет в базу: эндпоинт открытый, и любая запись
    // с секретом по запросу анонима выдавала бы этот секрет слушателям базы.
    if (url.pathname === '/health' && request.method === 'GET') {
      const botTokenConfigured = !!env.BOT_TOKEN;
      // true — Worker пишет в базу токеном сервисного аккаунта; без него все
      // эндпоинты (кроме этого) отвечают 500
      const firebaseAdminConfigured = !!env.FIREBASE_SERVICE_ACCOUNT;
      // какой бот у Worker'а (публичное имя/id, не токен): botTokenValid —
      // принимает ли Telegram токен (null — не удалось спросить)
      const bot = botTokenConfigured ? await getBotInfo(env) : { valid: false };
      // кто получает обновления бота (кнопки «Разрешить/Отклонить», команды):
      // ours: true — этот Worker; host — куда указывает чужой вебхук
      const telegramWebhook = botTokenConfigured && bot.valid ? await getWebhookSummary(env, url.origin) : null;
      if (botTokenConfigured && bot.valid) { try { await ensureBotProfile(env); } catch (err) { console.error('ensureBotProfile:', err && err.message); } } // после выкладки команды бота появляются сразу
      return jsonResponse({ botTokenConfigured, firebaseAdminConfigured, botTokenValid: bot.valid, botUsername: bot.username || null, botId: bot.id || null, botError: bot.error || null, telegramWebhook });
    }

    const needsGithubToken = ['/backup-now', '/restore-code', '/list-backups', '/download-backup', '/delete-backup', '/delete-backups'].includes(url.pathname);
    if (!env.BOT_TOKEN || !env.FIREBASE_SERVICE_ACCOUNT || (needsGithubToken && !env.GITHUB_TOKEN)) {
      return jsonResponse({ error: 'Worker не настроен (нет секретов)' }, 500);
    }

    if (url.pathname === '/grant-role' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'битый JSON' }, 400);
      }

      const { targetUserId, newRole } = body || {};
      if (!targetUserId || !newRole) {
        return jsonResponse({ error: 'нужны targetUserId, newRole' }, 400);
      }
      if (!SAFE_ID_RE.test(String(targetUserId))) {
        return jsonResponse({ error: 'некорректный targetUserId' }, 400);
      }
      if (!ALLOWED_ROLES.has(newRole)) {
        return jsonResponse({ error: `newRole должен быть одним из: ${[...ALLOWED_ROLES].join(', ')}` }, 400);
      }

      const verified = await verifyIdentity(body, env);
      if (!verified.ok) {
        return jsonResponse({ error: 'Проверка личности не прошла: ' + verified.reason }, 401);
      }

      const requesterRole = await getRole(verified.userId);
      if (!isSuperadmin(env, verified.userId, requesterRole)) {
        return jsonResponse({ error: 'Выдавать admin/superadmin может только существующий superadmin' }, 403);
      }

      try {
        await grantRole(env, verified.userId, String(targetUserId), newRole);
      } catch (err) {
        return jsonResponse({ error: 'Firebase отказал: ' + err.message }, 502);
      }

      return jsonResponse({ ok: true });
    }

    if (url.pathname === '/set-status' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'битый JSON' }, 400);
      }

      const { targetUserId, newStatus, restrictedUntil } = body || {};
      if (!targetUserId || !newStatus) {
        return jsonResponse({ error: 'нужны targetUserId, newStatus' }, 400);
      }
      if (!SAFE_ID_RE.test(String(targetUserId))) {
        return jsonResponse({ error: 'некорректный targetUserId' }, 400);
      }
      if (restrictedUntil != null && !(typeof restrictedUntil === 'number' && Number.isFinite(restrictedUntil))) {
        return jsonResponse({ error: 'restrictedUntil должен быть числом (время в мс) или null' }, 400);
      }
      if (!ALLOWED_STATUSES.has(newStatus)) {
        return jsonResponse({ error: `newStatus должен быть одним из: ${[...ALLOWED_STATUSES].join(', ')}` }, 400);
      }

      const verified = await verifyIdentity(body, env);
      if (!verified.ok) {
        return jsonResponse({ error: 'Проверка личности не прошла: ' + verified.reason }, 401);
      }

      const requesterRole = await getRole(verified.userId);
      if (!isStaff(env, verified.userId, requesterRole)) {
        return jsonResponse({ error: 'Менять статус может только админ/супердоступ' }, 403);
      }

      try {
        await setStatus(env, String(targetUserId), newStatus, restrictedUntil ?? null);
      } catch (err) {
        return jsonResponse({ error: 'Firebase отказал: ' + err.message }, 502);
      }

      return jsonResponse({ ok: true });
    }

    // Одобрение устройства — единственный способ получить доверенную запись
    // (см. комментарий у verifyDeviceTrust). Одобряет либо сам владелец
    // аккаунта (его личность подтверждена initData или уже доверенным
    // устройством — это парный код "Подключить по коду" и первый вход
    // суперадмина из Telegram), либо любой superadmin за другого человека
    // ("Администрация" → "Запросы на устройства"). deviceKey приходит уже
    // хэшем — сырой deviceId в базу и в заявки не попадает.
    if (url.pathname === '/trust-device' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'битый JSON' }, 400);
      }

      const { targetUserId, deviceKey, label, durationMs } = body || {};
      if (typeof deviceKey !== 'string' || !DEVICE_KEY_RE.test(deviceKey)) {
        return jsonResponse({ error: 'нужен deviceKey (sha256 в hex, 64 символа)' }, 400);
      }
      if (!/^\d+$/.test(String(targetUserId || ''))) {
        return jsonResponse({ error: 'нужен targetUserId (числовой telegramId)' }, 400);
      }
      if (durationMs != null && !(Number.isInteger(durationMs) && durationMs > 0 && durationMs <= MAX_TRUST_DURATION_MS)) {
        return jsonResponse({ error: 'durationMs должен быть целым положительным числом миллисекунд (или null — навсегда)' }, 400);
      }
      const uid = String(targetUserId);

      const verified = await verifyIdentity(body, env);
      if (!verified.ok) {
        return jsonResponse({ error: 'Проверка личности не прошла: ' + verified.reason }, 401);
      }

      // роль запрашивающего и наличие целевой записи не зависят друг от друга —
      // читаем параллельно (каждое чтение — отдельный круг до базы)
      const [requesterRole, targetExists] = await Promise.all([getRole(verified.userId), userExists(uid)]);
      const isSelf = verified.userId === uid;
      if (!(isSuperadmin(env, verified.userId, requesterRole) || (isSelf && STAFF_ROLES.has(requesterRole)))) {
        return jsonResponse({ error: 'Одобрять устройство может сам владелец аккаунта (модератор/админ/супердоступ) либо superadmin' }, 403);
      }

      // не плодим "пустые" users/<id> с одной лишь trustedDevices внутри
      if (!targetExists) {
        return jsonResponse({ error: 'пользователь не найден' }, 404);
      }

      // Устройство с временным доверием не может выдать больше, чем имеет
      // само: иначе оно одним вызовом превращало себя (или новое устройство)
      // в вечное. Вечное доверие передают только initData и вечные устройства.
      let effectiveDurationMs = durationMs || null;
      if (verified.via === 'device' && verified.expiresAt) {
        const remainingMs = Math.max(1, verified.expiresAt - Date.now()); // 0 в writeTrustedDevice означало бы "навсегда"
        effectiveDurationMs = effectiveDurationMs ? Math.min(effectiveDurationMs, remainingMs) : remainingMs;
      }

      try {
        await writeTrustedDevice(env, uid, deviceKey, {
          label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 64) : 'Устройство',
          durationMs: effectiveDurationMs,
          approvedBy: verified.userId,
        });
      } catch (err) {
        return jsonResponse({ error: 'Firebase отказал: ' + err.message }, 502);
      }

      return jsonResponse({ ok: true });
    }

    // Обновления от Telegram (нажатия кнопок, команды бота). Telegram шлёт POST
    // с секретом в заголовке — без него запрос отклоняется. Всегда отвечаем 200
    // после проверки секрета: на ошибку Telegram стал бы без конца повторять
    // то же обновление.
    if (url.pathname === TELEGRAM_WEBHOOK_PATH && request.method === 'POST') {
      if (!constantTimeEqual(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), await telegramWebhookSecret(env))) {
        return new Response('unauthorized', { status: 401 });
      }
      if (Number(request.headers.get('Content-Length') || 0) > 64 * 1024) return new Response('too large', { status: 413 });
      try {
        await handleTelegramUpdate(env, await request.json());
      } catch (err) {
        console.error('telegram-webhook:', err && err.message);
      }
      return new Response('ok', { status: 200 });
    }

    if (url.pathname === '/vc-membership' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ ok: false, error: 'битый JSON' }, 400);
      }
      try {
        return jsonResponse(await checkVideochatMembership(env, body));
      } catch (err) {
        return jsonResponse({ ok: false, error: 'Не удалось проверить: ' + String((err && err.message) || err).slice(0, 80) }, 502);
      }
    }

    if (url.pathname === '/login-notify' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'битый JSON' }, 400);
      }
      const { telegramId, requestId } = body || {};
      if (!/^\d+$/.test(String(telegramId || '')) || !/^[A-Za-z0-9_-]+$/.test(String(requestId || ''))) {
        return jsonResponse({ error: 'нужны telegramId (число) и requestId' }, 400);
      }
      try {
        const result = await notifyLoginRequest(env, String(telegramId), String(requestId), url.origin);
        return jsonResponse({ ok: true, ...result });
      } catch (err) {
        return jsonResponse({ error: err.message }, 400);
      }
    }

    if (url.pathname === '/finish-match' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'битый JSON' }, 400);
      }

      const { initData, matchId, winnerSide } = body || {};
      if (!initData || !matchId || (winnerSide !== 'host' && winnerSide !== 'guest')) {
        return jsonResponse({ error: 'нужны initData, matchId, winnerSide (host|guest)' }, 400);
      }
      if (!SAFE_ID_RE.test(String(matchId))) {
        return jsonResponse({ error: 'некорректный matchId' }, 400);
      }

      const verified = await verifyTelegramInitData(initData, env.BOT_TOKEN);
      if (!verified.ok) {
        return jsonResponse({ error: 'Telegram initData не прошла проверку: ' + verified.reason }, 401);
      }

      const requesterPlayerId = await getUserField(verified.userId, 'playerId');
      if (!requesterPlayerId) {
        return jsonResponse({ error: 'Профиль запрашивающего не найден' }, 403);
      }

      try {
        const result = await finishMatch(env, requesterPlayerId, String(matchId), winnerSide);
        return jsonResponse({ ok: true, ...result });
      } catch (err) {
        return jsonResponse({ error: err.message }, 400);
      }
    }

    if (url.pathname === '/restore-database' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'битый JSON' }, 400);
      }

      const { data } = body || {};
      if (!data || typeof data !== 'object') {
        return jsonResponse({ error: 'нужны initData (или telegramId+deviceId), data (снимок базы)' }, 400);
      }

      const verified = await verifyIdentity(body, env);
      if (!verified.ok) {
        return jsonResponse({ error: 'Проверка личности не прошла: ' + verified.reason }, 401);
      }

      const requesterRole = await getRole(verified.userId);
      if (!isSuperadmin(env, verified.userId, requesterRole)) {
        return jsonResponse({ error: 'Восстанавливать базу может только superadmin' }, 403);
      }

      try {
        await restoreDatabase(env, data);
      } catch (err) {
        return jsonResponse({ error: 'Firebase отказал: ' + err.message }, 502);
      }

      return jsonResponse({ ok: true });
    }

    if (url.pathname === '/backup-now' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'битый JSON' }, 400);
      }

      const verified = await verifyIdentity(body, env);
      if (!verified.ok) {
        return jsonResponse({ error: 'Проверка личности не прошла: ' + verified.reason }, 401);
      }

      const requesterRole = await getRole(verified.userId);
      if (!hasBackupsAccess(env, verified.userId, requesterRole)) {
        return jsonResponse({ error: 'Нет прав на управление бэкапами' }, 403);
      }

      try {
        await triggerBackupNow(env);
      } catch (err) {
        return jsonResponse({ error: 'GitHub отказал: ' + err.message }, 502);
      }

      return jsonResponse({ ok: true });
    }

    if (url.pathname === '/restore-code' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'битый JSON' }, 400);
      }

      const { repo, files } = body || {};
      if (!repo || !files) {
        return jsonResponse({ error: 'нужны repo, files' }, 400);
      }

      const verified = await verifyIdentity(body, env);
      if (!verified.ok) {
        return jsonResponse({ error: 'Проверка личности не прошла: ' + verified.reason }, 401);
      }

      const requesterRole = await getRole(verified.userId);
      if (!hasBackupsAccess(env, verified.userId, requesterRole)) {
        return jsonResponse({ error: 'Нет прав на управление бэкапами' }, 403);
      }

      try {
        await restoreCode(env, repo, files);
      } catch (err) {
        return jsonResponse({ error: 'GitHub отказал: ' + err.message }, 502);
      }

      return jsonResponse({ ok: true });
    }

    if (url.pathname === '/list-backups' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'битый JSON' }, 400);
      }

      const verified = await verifyIdentity(body, env);
      if (!verified.ok) {
        return jsonResponse({ error: 'Проверка личности не прошла: ' + verified.reason }, 401);
      }

      const requesterRole = await getRole(verified.userId);
      if (!hasBackupsAccess(env, verified.userId, requesterRole)) {
        return jsonResponse({ error: 'Нет прав на управление бэкапами' }, 403);
      }

      try {
        const [codeIndex, codeAdmin, db] = await Promise.all([
          ghListDir(env, 'code-backups/index.html'),
          ghListDir(env, 'code-backups/battle-admin-bot'),
          ghListDir(env, 'db-snapshots'),
        ]);
        return jsonResponse({ codeIndex, codeAdmin, db });
      } catch (err) {
        return jsonResponse({ error: 'GitHub отказал: ' + err.message }, 502);
      }
    }

    if (url.pathname === '/download-backup' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'битый JSON' }, 400);
      }

      const { path } = body || {};
      if (!path) {
        return jsonResponse({ error: 'нужен path' }, 400);
      }
      // Жёсткий allowlist путей — это единственная защита от того, чтобы
      // через этот прокси не читали произвольные файлы приватного
      // репозитория (например, секреты в других ветках/папках).
      if (typeof path !== 'string' || path.includes('..') || !/^(code-backups\/(index\.html|battle-admin-bot)\/[A-Za-z0-9._-]+\.zip|db-snapshots\/[A-Za-z0-9._-]+\.json)$/.test(path)) {
        return jsonResponse({ error: 'путь недопустим' }, 400);
      }

      const verified = await verifyIdentity(body, env);
      if (!verified.ok) {
        return jsonResponse({ error: 'Проверка личности не прошла: ' + verified.reason }, 401);
      }

      const requesterRole = await getRole(verified.userId);
      if (!hasBackupsAccess(env, verified.userId, requesterRole)) {
        return jsonResponse({ error: 'Нет прав на управление бэкапами' }, 403);
      }

      let ghRes;
      try {
        ghRes = await ghDownloadFile(env, path);
      } catch (err) {
        return jsonResponse({ error: 'GitHub отказал: ' + err.message }, 502);
      }

      const filename = path.split('/').pop();
      return new Response(ghRes.body, {
        status: 200,
        headers: {
          'Content-Type': path.endsWith('.zip') ? 'application/zip' : 'application/json',
          'Content-Disposition': `attachment; filename="${filename}"`,
          ...CORS_HEADERS,
        },
      });
    }

    if (url.pathname === '/delete-backup' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'битый JSON' }, 400);
      }

      const { path } = body || {};
      if (!path) {
        return jsonResponse({ error: 'нужен path' }, 400);
      }
      // Тот же allowlist, что и у download-backup — удалять из приватного
      // репозитория можно только сами снимки, ничего больше.
      if (!isBackupPathAllowed(path)) {
        return jsonResponse({ error: 'путь недопустим' }, 400);
      }

      const verified = await verifyIdentity(body, env);
      if (!verified.ok) {
        return jsonResponse({ error: 'Проверка личности не прошла: ' + verified.reason }, 401);
      }

      const requesterRole = await getRole(verified.userId);
      if (!hasBackupsAccess(env, verified.userId, requesterRole)) {
        return jsonResponse({ error: 'Нет прав на управление бэкапами' }, 403);
      }

      try {
        await ghDeleteFile(env, path);
      } catch (err) {
        return jsonResponse({ error: 'GitHub отказал: ' + err.message }, 502);
      }

      return jsonResponse({ ok: true });
    }

    // Пакетное удаление: тот же контракт и те же проверки, что у /delete-backup,
    // но paths — список, а удаление идёт одним коммитом (см. ghDeleteFiles:
    // N вызовов /delete-backup упёрлись бы в лимит подзапросов и в 409).
    if (url.pathname === '/delete-backups' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'битый JSON' }, 400);
      }

      const { paths } = body || {};
      if (!Array.isArray(paths) || !paths.length) {
        return jsonResponse({ error: 'нужен paths — непустой список путей' }, 400);
      }
      if (paths.length > MAX_DELETE_PATHS) {
        return jsonResponse({ error: `слишком много путей за раз (максимум ${MAX_DELETE_PATHS})` }, 400);
      }
      // Каждый путь — через тот же allowlist, что и у /delete-backup: одного
      // недопустимого достаточно, чтобы отклонить весь запрос целиком, ничего
      // не удаляя.
      if (!paths.every(isBackupPathAllowed)) {
        return jsonResponse({ error: 'путь недопустим' }, 400);
      }

      const verified = await verifyIdentity(body, env);
      if (!verified.ok) {
        return jsonResponse({ error: 'Проверка личности не прошла: ' + verified.reason }, 401);
      }

      const requesterRole = await getRole(verified.userId);
      if (!hasBackupsAccess(env, verified.userId, requesterRole)) {
        return jsonResponse({ error: 'Нет прав на управление бэкапами' }, 403);
      }

      let result;
      try {
        result = await ghDeleteFiles(env, paths);
      } catch (err) {
        return jsonResponse({ error: 'GitHub отказал: ' + err.message }, 502);
      }

      return jsonResponse({ ok: true, deleted: result.deleted, missing: result.missing });
    }

    return jsonResponse({ error: 'not found' }, 404);
  },
};
