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
const GITHUB_OWNER = 'botsystemtioxsit';
const DATA_REPO = 'battle-data-admin-bot';
const CODE_REPOS = new Set(['index.html', 'battle-admin-bot']);
const ALLOWED_ROLES = new Set(['admin', 'superadmin']);
const ALLOWED_STATUSES = new Set(['active', 'restricted', 'banned']);
const STAFF_ROLES = new Set(['moderator', 'admin', 'superadmin']);
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

// Проверка через доверенное устройство (users/$uid/trustedDevices/$deviceId)
// — альтернатива initData для бэкапов, чтобы они работали не только внутри
// настоящей Telegram-сессии, но и из desktop-приложения/обычного браузера
// (проект кроссплатформенный, initData там принципиально недоступен — это
// не Telegram Mini App). deviceId — 128 бит случайности
// (crypto.getRandomValues, см. randomToken в admin.html), известен только
// тому браузеру, для которого он сгенерирован, и попадает в trustedDevices
// только через явное одобрение существующим Супердоступом (см.
// "Администрация" → "Запросы на устройства") — то же самое доказательство
// личности, которое уже требуется для входа в панель под admin/superadmin
// вообще (см. комментарий у protectedRoles в admin.html), просто теперь
// проверяется ещё и здесь, а не только на клиенте.
// Не подменяет initData для /grant-role и /set-status — эти два трогать не
// просили, и там цена ошибки (выдать чужую роль) выше.
async function verifyDeviceTrust(telegramId, deviceId) {
  if (!telegramId || !deviceId) return { ok: false, reason: 'нужны telegramId и deviceId' };
  const res = await fetch(`${FIREBASE_DB_URL}/users/${encodeURIComponent(telegramId)}/trustedDevices/${encodeURIComponent(deviceId)}.json`);
  if (!res.ok) return { ok: false, reason: 'Firebase недоступен' };
  const val = await res.json();
  if (!val) return { ok: false, reason: 'устройство не доверено' };
  // Временное доверие (см. "Запросы на устройства" в admin.html) —
  // expiresAt задаётся при одобрении, null/отсутствует значит "навсегда".
  // Проверяем именно здесь, а не только на клиенте: клиентская проверка —
  // это просто UX (не пускает на устаревший экран раньше времени), а этот
  // Worker — единственное место, которое реально решает, можно ли трогать
  // GITHUB_TOKEN.
  if (val.expiresAt && val.expiresAt <= Date.now()) {
    return { ok: false, reason: 'доверие устройству истекло' };
  }
  return { ok: true, userId: String(telegramId) };
}

// Общая точка входа для проверки личности на бэкап-эндпоинтах: initData,
// если она есть (сильнее — подпись Telegram), иначе deviceId (см. выше).
async function verifyIdentity(body, env) {
  if (body.initData) return verifyTelegramInitData(body.initData, env.BOT_TOKEN);
  if (body.telegramId && body.deviceId) return verifyDeviceTrust(body.telegramId, body.deviceId);
  return { ok: false, reason: 'нужны initData либо telegramId+deviceId' };
}

async function getRole(userId) {
  const res = await fetch(`${FIREBASE_DB_URL}/users/${encodeURIComponent(userId)}/role.json`);
  if (!res.ok) return null;
  return res.json();
}

async function getUser(telegramId) {
  const res = await fetch(`${FIREBASE_DB_URL}/users/${encodeURIComponent(telegramId)}.json`);
  if (!res.ok) return null;
  return res.json();
}

// Бэкапы/восстановление — не только для superadmin: admin.html позволяет
// делегировать это конкретному admin через users/$uid/permissions/backups
// (canManageEvent/canManageClans и т.п. — тот же паттерн), поэтому гейт
// здесь шире, чем строгий superadmin у /restore-database ниже (это самое
// разрушительное действие из всех — полная перезапись базы — его сознательно
// не делегируем).
function hasBackupsAccess(user) {
  return !!user && (user.role === 'superadmin' || (user.permissions && user.permissions.backups === true));
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

// Реальный сквозной тест: пытается провести тестовую учётку через ровно
// тот же путь, что и настоящая выдача роли (users/$uid/role +
// roleGrantKey), и сразу убирает её независимо от результата — это не
// настоящий игрок, ему не место в списке пользователей панели. Отвечает
// true только если ROLE_GRANT_KEY в этом Worker'е реально совпадает с тем,
// что сейчас задеплоено в database.rules.json (а не просто "оба заданы,
// но разъехались" — именно так и ломалась выдача роли раньше).
async function checkRoleGrantKeyMatchesRules(env) {
  const testRes = await fetch(`${FIREBASE_DB_URL}/users/_role_gateway_healthcheck_.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'admin', roleGrantKey: env.ROLE_GRANT_KEY }),
  });
  const matches = testRes.ok;
  await fetch(`${FIREBASE_DB_URL}/users/_role_gateway_healthcheck_.json`, { method: 'DELETE' }).catch(() => {});
  return matches;
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

// Бан/разбан чужого аккаунта — то же самое зеркало, что и grantRole, но
// для users/$uid/status. Нужен отдельно от прямой записи из admin.html,
// потому что для аккаунтов с owners-записью (см. index.html, Anonymous
// Auth) database.rules.json больше не пускает чужой auth.uid менять
// status без adminActionKey — тот самый секрет, который знает только этот
// Worker.
async function setStatus(env, targetUserId, newStatus, restrictedUntil) {
  const patchRes = await fetch(`${FIREBASE_DB_URL}/users/${encodeURIComponent(targetUserId)}.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: newStatus, restrictedUntil: restrictedUntil ?? null, adminActionKey: env.ROLE_GRANT_KEY }),
  });
  if (!patchRes.ok) {
    throw new Error(`Firebase PATCH ${patchRes.status}: ${await patchRes.text()}`);
  }
  await fetch(`${FIREBASE_DB_URL}/users/${encodeURIComponent(targetUserId)}/adminActionKey.json`, {
    method: 'DELETE',
  }).catch(() => {});
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
  if (battle.refereeId !== refereePlayerId) throw new Error('Вы не назначены судьёй этого боя');

  const winnerId = winnerSide === 'host' ? battle.hostId : battle.guestId;
  const loserId = winnerSide === 'host' ? battle.guestId : battle.hostId;
  if (!winnerId || !loserId) throw new Error('В бою не хватает участника');

  const winnerRec = await getUserByPlayerId(winnerId);
  const loserRec = await getUserByPlayerId(loserId);
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

  const likesRes = await fetch(`${FIREBASE_DB_URL}/battles/${encodeURIComponent(matchId)}/audienceLikes.json`);
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

  const touchedKeys = [];
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
    update[`users/${rec.key}/adminActionKey`] = env.ROLE_GRANT_KEY;
    touchedKeys.push(rec.key);
  }

  const refRec = await getUserByPlayerId(refereePlayerId);
  if (refRec) {
    const u = refRec.user;
    update[`users/${refRec.key}/stats/refereeBattles`] = Number(u.stats?.refereeBattles || 0) + 1;
    update[`users/${refRec.key}/starsBalance`] = Number(u.starsBalance || 0) + REFEREE_STARS_REWARD;
    update[`users/${refRec.key}/adminActionKey`] = env.ROLE_GRANT_KEY;
    touchedKeys.push(refRec.key);
  }

  const patchRes = await fetch(`${FIREBASE_DB_URL}/.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
  if (!patchRes.ok) {
    throw new Error(`Firebase PATCH ${patchRes.status}: ${await patchRes.text()}`);
  }

  const cleanup = {};
  for (const key of touchedKeys) cleanup[`users/${key}/adminActionKey`] = null;
  await fetch(`${FIREBASE_DB_URL}/.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cleanup),
  }).catch(() => {});

  return { winnerId, loserId, pointsAwarded, audienceVotes, trophyMultiplier: 1 };
}

// Полное восстановление базы из снимка (battle-data-admin-bot, вкладка
// «Восстановление» → «Восстановить базу»). Раньше это был прямой
// db.ref('/').set(data) с клиента — работало, пока database.rules.json не
// обзавёлся .validate-правилами на users/$uid/role (нужен roleGrantKey для
// admin/superadmin) и на status/points/starsBalance (нужен adminActionKey
// для аккаунтов с owners-записью). Снимок этих служебных полей не содержит
// (они одноразовые и стираются сразу после использования — см. grantRole/
// setStatus выше), поэтому голый set(data) с любым непустым снимком реальных
// пользователей стал отклоняться правилами. Чинится тем же приёмом, что и
// остальной файл: секрет знает только Worker, поэтому restore идёт через
// него — перед записью подмешивает roleGrantKey/adminActionKey в те записи
// users/$uid, которым он понадобится, пишет весь снимок одним PUT в корень,
// затем чистит подмешанные поля отдельным PATCH.
async function restoreDatabase(env, snapshot) {
  const payload = snapshot && typeof snapshot === 'object' ? { ...snapshot } : {};
  const touchedForRole = [];
  const touchedForAction = [];

  if (payload.users && typeof payload.users === 'object') {
    const usersCopy = {};
    for (const [uid, rec] of Object.entries(payload.users)) {
      if (!rec || typeof rec !== 'object') { usersCopy[uid] = rec; continue; }
      const u = { ...rec };
      if (u.role === 'admin' || u.role === 'superadmin') {
        u.roleGrantKey = env.ROLE_GRANT_KEY;
        touchedForRole.push(uid);
      }
      if (u.status !== undefined || u.points !== undefined || u.starsBalance !== undefined) {
        u.adminActionKey = env.ROLE_GRANT_KEY;
        touchedForAction.push(uid);
      }
      usersCopy[uid] = u;
    }
    payload.users = usersCopy;
  }

  const putRes = await fetch(`${FIREBASE_DB_URL}/.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!putRes.ok) {
    throw new Error(`Firebase PUT ${putRes.status}: ${await putRes.text()}`);
  }

  const cleanup = {};
  for (const uid of touchedForRole) cleanup[`users/${uid}/roleGrantKey`] = null;
  for (const uid of touchedForAction) cleanup[`users/${uid}/adminActionKey`] = null;
  if (Object.keys(cleanup).length) {
    await fetch(`${FIREBASE_DB_URL}/.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cleanup),
    }).catch(() => {});
  }
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
    throw new Error(`${path} -> ${res.status}: ${body}`);
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
    // не попадают.
    if (url.pathname === '/health' && request.method === 'GET') {
      const botTokenConfigured = !!env.BOT_TOKEN;
      const roleGrantKeyConfigured = !!env.ROLE_GRANT_KEY;
      const roleGrantKeyMatchesRules = roleGrantKeyConfigured ? await checkRoleGrantKeyMatchesRules(env) : false;
      return jsonResponse({ botTokenConfigured, roleGrantKeyConfigured, roleGrantKeyMatchesRules });
    }

    const needsGithubToken = ['/backup-now', '/restore-code', '/list-backups', '/download-backup', '/delete-backup'].includes(url.pathname);
    if (!env.BOT_TOKEN || !env.ROLE_GRANT_KEY || (needsGithubToken && !env.GITHUB_TOKEN)) {
      return jsonResponse({ error: 'Worker не настроен (нет секретов)' }, 500);
    }

    if (url.pathname === '/grant-role' && request.method === 'POST') {
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
    }

    if (url.pathname === '/set-status' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'битый JSON' }, 400);
      }

      const { initData, targetUserId, newStatus, restrictedUntil } = body || {};
      if (!initData || !targetUserId || !newStatus) {
        return jsonResponse({ error: 'нужны initData, targetUserId, newStatus' }, 400);
      }
      if (!ALLOWED_STATUSES.has(newStatus)) {
        return jsonResponse({ error: `newStatus должен быть одним из: ${[...ALLOWED_STATUSES].join(', ')}` }, 400);
      }

      const verified = await verifyTelegramInitData(initData, env.BOT_TOKEN);
      if (!verified.ok) {
        return jsonResponse({ error: 'Telegram initData не прошла проверку: ' + verified.reason }, 401);
      }

      const requesterRole = await getRole(verified.userId);
      if (!STAFF_ROLES.has(requesterRole)) {
        return jsonResponse({ error: 'Менять статус может только модератор/админ/супердоступ' }, 403);
      }

      try {
        await setStatus(env, String(targetUserId), newStatus, restrictedUntil ?? null);
      } catch (err) {
        return jsonResponse({ error: 'Firebase отказал: ' + err.message }, 502);
      }

      return jsonResponse({ ok: true });
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

      const verified = await verifyTelegramInitData(initData, env.BOT_TOKEN);
      if (!verified.ok) {
        return jsonResponse({ error: 'Telegram initData не прошла проверку: ' + verified.reason }, 401);
      }

      const requester = await getUser(verified.userId);
      if (!requester || !requester.playerId) {
        return jsonResponse({ error: 'Профиль запрашивающего не найден' }, 403);
      }

      try {
        const result = await finishMatch(env, requester.playerId, String(matchId), winnerSide);
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
      if (requesterRole !== 'superadmin') {
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

      const requester = await getUser(verified.userId);
      if (!hasBackupsAccess(requester)) {
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

      const requester = await getUser(verified.userId);
      if (!hasBackupsAccess(requester)) {
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

      const requester = await getUser(verified.userId);
      if (!hasBackupsAccess(requester)) {
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
      if (!/^(code-backups\/(index\.html|battle-admin-bot)\/[^/]+\.zip|db-snapshots\/[^/]+\.json)$/.test(path)) {
        return jsonResponse({ error: 'путь недопустим' }, 400);
      }

      const verified = await verifyIdentity(body, env);
      if (!verified.ok) {
        return jsonResponse({ error: 'Проверка личности не прошла: ' + verified.reason }, 401);
      }

      const requester = await getUser(verified.userId);
      if (!hasBackupsAccess(requester)) {
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
      if (!/^(code-backups\/(index\.html|battle-admin-bot)\/[^/]+\.zip|db-snapshots\/[^/]+\.json)$/.test(path)) {
        return jsonResponse({ error: 'путь недопустим' }, 400);
      }

      const verified = await verifyIdentity(body, env);
      if (!verified.ok) {
        return jsonResponse({ error: 'Проверка личности не прошла: ' + verified.reason }, 401);
      }

      const requester = await getUser(verified.userId);
      if (!hasBackupsAccess(requester)) {
        return jsonResponse({ error: 'Нет прав на управление бэкапами' }, 403);
      }

      try {
        await ghDeleteFile(env, path);
      } catch (err) {
        return jsonResponse({ error: 'GitHub отказал: ' + err.message }, 502);
      }

      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: 'not found' }, 404);
  },
};
