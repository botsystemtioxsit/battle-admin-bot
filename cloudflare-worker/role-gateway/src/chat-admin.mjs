// Админ-бот для Telegram-чатов: модерация (бан, мут, предупреждения, удаление) и статистика входов.
// Это модуль Worker'а: сам он ничего не знает про Worker — всё внешнее (Telegram, база, id владельцев) приходит в `deps`,
// поэтому его можно проверять тестами на подставных данных (test/chat-admin.test.mjs).
//
// Данные лежат в основной базе в узле chatAdmin/<id чата> (правила базы закрывают его от чтения списком и от записи клиентами —
// пишет только Worker токеном сервисного аккаунта, читает панель через /admin-read, только Супердоступ):
//   meta                  {enabled, title, type, enabledAt, enabledBy, botStatus, prunedDay, cfg:{…настройки…}}
//   events/<день>/<id>    события: {t:'join'|'leave'|'ban'|'unban'|'mod', at, id, name, username?, how?, link?, by?, action?, details?}
//   daily/<день>          счётчики: joins, leaves, bans, messages, how_<способ>, hr/<час UTC>
//   users/<id>            {name, username?, lang?, premium?, joinedAt?, how?, linkId?, status, lastSeen, messages, warns}
//   links/<id>            {name, creator?, joins, lastJoin} — пригласительные ссылки (по хешу; сама ссылка НЕ хранится: по ней может войти кто угодно)
//   pending/<id>          проверка «я не бот»: {at, until, msgId, name, kicked?} — новичок ограничен, пока не нажмёт кнопку (или его выгонят по таймеру)
//   _global/bans/<id>     «бан везде»: {at, by, byName, reason, name, username?, game, videochat, chats:{ok,fail}} — человек заблокирован во всех
//                         включённых чатах (пре-бан: не может зайти), в игре (users/<id>/status) и в ВидеоЧате (videochat/bans/<id>)
//   _global/chats/<id>    список включённых чатов (чтобы «бан везде» не перебирал всю базу)
// Текст сообщений людей НЕ сохраняется — только счётчики.
// «Где» человек зашёл Telegram боту не сообщает (адреса и места нет): известно только КАК — по пригласительной ссылке (какой),
// его добавил участник, заявка, папка чатов или сам (поиск / публичная ссылка).

export const DAY_MS = 86_400_000;
const GLOBAL = 'chatAdmin/_global';
const EVENTS_KEEP_DAYS = 120;
const DAILY_KEEP_DAYS = 800;
const CFG_DEFAULTS = Object.freeze({ welcome: false, welcomeText: '', rules: '', links: false, cleanup: false, count: true, maxWarns: 3, tz: 'Europe/Berlin', captcha: true, captchaSec: 10 });
export const CFG_KEYS = Object.freeze({ welcome: 'bool', links: 'bool', cleanup: 'bool', count: 'bool', captcha: 'bool', maxWarns: 'num', captchaSec: 'num', tz: 'tz', welcomeText: 'text', rules: 'text' });
const MEMBER_STATUSES = new Set(['creator', 'administrator', 'member']);
const HOW_LABELS = { invite: 'по пригласительной ссылке', added: 'добавил участник', request: 'по заявке', folder: 'по папке чатов', direct: 'сам (поиск или публичная ссылка)' };

// ---------- чистые помощники ----------
const CONTROL_RE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ufeff]', 'g');
export function dayKey(ms) { return new Date(ms).toISOString().slice(0, 10); }
export function cleanText(v, max = 60) {
  return String(v ?? '').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
export function displayName(u) {
  const n = [u && u.first_name, u && u.last_name].filter(Boolean).join(' ');
  return cleanText(n || (u && u.username) || 'Без имени', 60);
}
export function isMember(m) { return !!m && (MEMBER_STATUSES.has(m.status) || (m.status === 'restricted' && m.is_member === true)); }
const inc = (n = 1) => ({ '.sv': { increment: n } });
export function eventId(at) { return String(at).padStart(13, '0') + '-' + Math.random().toString(36).slice(2, 6); }
export function chatKeyOf(chatId) { const k = String(chatId); return /^-?\d{1,20}$/.test(k) ? k : null; }
export function userKeyOf(id) { const k = String(id); return /^\d{1,15}$/.test(k) ? k : null; }

// «/ban@мой_бот причина» → { name:'ban', args:'причина' }; чужому боту (@other_bot) — null
export function parseCommand(text, botUsername) {
  const m = /^\/([A-Za-z_]{1,32})(?:@([A-Za-z0-9_]{3,64}))?(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  if (!m) return null;
  if (m[2] && (!botUsername || m[2].toLowerCase() !== String(botUsername).toLowerCase())) return null;
  return { name: m[1].toLowerCase(), args: String(m[3] || '').trim() };
}

// «30» → 30 минут, «2h», «1d», «45m»; пусто → по умолчанию; не меньше минуты и не больше 366 дней
export function parseDuration(s, defaultMinutes = 60) {
  const t = String(s || '').trim().toLowerCase();
  if (!t) return defaultMinutes * 60;
  const m = /^(\d{1,6})\s*([mhdмчд]?)/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] === 'h' || m[2] === 'ч' ? 3600 : m[2] === 'd' || m[2] === 'д' ? 86400 : 60;
  const sec = n * unit;
  return sec < 60 ? 60 : Math.min(sec, 366 * 86400);
}
export function formatDuration(sec) {
  if (sec >= 86400 && sec % 86400 === 0) return sec / 86400 + ' дн.';
  if (sec >= 3600 && sec % 3600 === 0) return sec / 3600 + ' ч.';
  return Math.round(sec / 60) + ' мин.';
}

// Событие входа/выхода из обновления chat_member (или null, если ничего не изменилось). `how` — способ входа.
export function describeChatMember(update) {
  const cm = update && update.chat_member;
  if (!cm || !cm.old_chat_member || !cm.new_chat_member || !cm.new_chat_member.user) return null;
  const old = cm.old_chat_member;
  const nw = cm.new_chat_member;
  const user = nw.user;
  const was = isMember(old);
  const now = isMember(nw);
  const at = Number(cm.date) > 0 ? Number(cm.date) * 1000 : Date.now();
  const by = cm.from && cm.from.id !== user.id ? { id: String(cm.from.id), name: displayName(cm.from) } : null;
  if (!was && now) {
    let how = 'direct';
    let link = null;
    if (cm.via_join_request) how = 'request';
    else if (cm.via_chat_folder_invite_link) how = 'folder';
    else if (cm.invite_link && cm.invite_link.invite_link) {
      how = 'invite';
      const l = cm.invite_link;
      link = { raw: String(l.invite_link), name: cleanText(l.name, 40), creator: l.creator ? displayName(l.creator) : '' };
    } else if (by) how = 'added';
    return { kind: 'join', user, at, how, by, link };
  }
  if (was && !now) return { kind: nw.status === 'kicked' ? 'ban' : by ? 'removed' : 'leave', user, at, by };
  if (!was && !now && nw.status === 'kicked' && old.status !== 'kicked') return { kind: 'ban', user, at, by };
  if (old.status === 'kicked' && nw.status === 'left') return { kind: 'unban', user, at, by };
  return null;
}

async function sha1hex(text) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

// Подпись способа входа для людей
export function howText(how, link, by) {
  if (how === 'invite') return 'по ссылке' + (link && link.name ? ' «' + link.name + '»' : '') + (link && link.creator ? ' (создал ' + link.creator + ')' : '');
  if (how === 'added') return 'его добавил ' + (by && by.name ? by.name : 'участник');
  return HOW_LABELS[how] || 'способ неизвестен';
}

// Пишущие запросы одним пакетом (PATCH корня базы с путями через «/»): события → счётчики дня, запись человека, счётчик ссылки.
export function eventWrites(chatKey, ev, linkId) {
  const base = `chatAdmin/${chatKey}`;
  const uid = userKeyOf(ev.user.id);
  const day = dayKey(ev.at);
  const w = {};
  const rec = { t: ev.kind, at: ev.at, id: uid, name: displayName(ev.user) };
  if (ev.user.username) rec.username = cleanText(ev.user.username, 40);
  if (ev.how) rec.how = ev.how;
  if (ev.link) rec.link = { id: linkId, name: ev.link.name || '', creator: ev.link.creator || '' };
  if (ev.by) rec.by = ev.by;
  w[`${base}/events/${day}/${eventId(ev.at)}`] = rec;
  if (ev.kind === 'join') {
    w[`${base}/daily/${day}/joins`] = inc();
    w[`${base}/daily/${day}/how_${ev.how}`] = inc();
    w[`${base}/users/${uid}/name`] = rec.name;
    w[`${base}/users/${uid}/username`] = rec.username || null;
    w[`${base}/users/${uid}/lang`] = ev.user.language_code ? cleanText(ev.user.language_code, 12) : null;
    w[`${base}/users/${uid}/premium`] = ev.user.is_premium ? true : null;
    w[`${base}/users/${uid}/joinedAt`] = ev.at;
    w[`${base}/users/${uid}/how`] = ev.how;
    w[`${base}/users/${uid}/linkId`] = linkId || null;
    w[`${base}/users/${uid}/status`] = 'member';
    if (linkId) {
      w[`${base}/links/${linkId}/joins`] = inc();
      w[`${base}/links/${linkId}/name`] = ev.link.name || 'ссылка без названия';
      w[`${base}/links/${linkId}/creator`] = ev.link.creator || null;
      w[`${base}/links/${linkId}/lastJoin`] = ev.at;
    }
  } else if (ev.kind === 'leave' || ev.kind === 'removed') {
    w[`${base}/daily/${day}/leaves`] = inc();
    w[`${base}/users/${uid}/status`] = 'left';
    w[`${base}/users/${uid}/leftAt`] = ev.at;
  } else if (ev.kind === 'ban') {
    w[`${base}/daily/${day}/bans`] = inc();
    w[`${base}/users/${uid}/status`] = 'banned';
    w[`${base}/users/${uid}/leftAt`] = ev.at;
  } else if (ev.kind === 'unban') {
    w[`${base}/users/${uid}/status`] = 'left';
  }
  return w;
}

// Ошибки Bot API — человеческим языком
export function explainTgError(description) {
  const d = String(description || '');
  if (/not enough rights|CHAT_ADMIN_REQUIRED|need administrator rights|have no rights/i.test(d)) return 'У бота нет нужного права администратора (удаление сообщений / блокировка участников). Дайте его в настройках чата.';
  if (/user is an administrator|can't remove chat owner|can't restrict|USER_ADMIN_INVALID/i.test(d)) return 'Это администратор чата — его нельзя ограничить.';
  if (/user not found|USER_ID_INVALID|PARTICIPANT_ID_INVALID/i.test(d)) return 'Не нашёл такого человека в чате.';
  if (/message to delete not found|message can't be deleted/i.test(d)) return 'Это сообщение уже нельзя удалить.';
  if (/chat not found|bot was kicked|bot is not a member/i.test(d)) return 'Бота нет в этом чате.';
  return 'Telegram отказал: ' + cleanText(d, 100);
}

const ALL_FALSE = Object.freeze({ can_send_messages: false, can_send_audios: false, can_send_documents: false, can_send_photos: false, can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false, can_add_web_page_previews: false, can_change_info: false, can_invite_users: false, can_pin_messages: false, can_manage_topics: false });
const ALL_TRUE = Object.freeze(Object.fromEntries(Object.keys(ALL_FALSE).map((k) => [k, true])));

// ---------- сам модуль ----------
// deps: { tg(method, payload) → ответ Bot API; dbGet(path) → значение (путь без .json); dbUpdate({путь: значение}) — пакет записей;
//         dbPut(path, value); dbDelete(path); owners:Set<строка>; botId; botUsername; now():мс }
export function createChatAdmin(deps) {
  const now = () => (deps.now ? deps.now() : Date.now());
  const owners = deps.owners || new Set();
  const metaCache = new Map(); // chatKey → { at, meta }
  const adminCache = new Map(); // chatKey:userId → { at, ok }
  const noticeAt = new Map(); // chatKey → мс последнего замечания про ссылки
  const sweepAt = new Map(); // chatKey → мс последней проверки «кого пора выгнать» (не чаще раза в 30 с на чат)
  let bannedCache = { at: 0, set: new Set() }; // id людей из «бана везде», раз в минуту перечитывается
  const META_TTL = 2 * 60 * 1000;

  const say = (chatId, text, extra) => deps.tg('sendMessage', { chat_id: chatId, text: String(text).slice(0, 4000), ...(extra || {}) });

  async function getMeta(chatKey, fresh = false) {
    const hit = metaCache.get(chatKey);
    if (!fresh && hit && now() - hit.at < META_TTL) return hit.meta;
    const meta = await deps.dbGet(`chatAdmin/${chatKey}/meta`).catch(() => undefined);
    if (meta === undefined) return hit ? hit.meta : null; // база не ответила — используем прежнее, не «выключаем» чат
    metaCache.set(chatKey, { at: now(), meta: meta && typeof meta === 'object' ? meta : null });
    return metaCache.get(chatKey).meta;
  }
  const cfgOf = (meta) => ({ ...CFG_DEFAULTS, ...((meta && meta.cfg) || {}) });

  async function memberStatus(chatId, userId) {
    const r = await deps.tg('getChatMember', { chat_id: chatId, user_id: Number(userId) });
    if (r && r.ok && r.result) return r.result.status === 'restricted' ? (r.result.is_member ? 'member' : 'left') : r.result.status;
    return null;
  }
  async function isChatAdmin(chatId, userId) {
    if (owners.has(String(userId))) return true;
    const k = chatId + ':' + userId;
    const hit = adminCache.get(k);
    if (hit && now() - hit.at < 60_000) return hit.ok;
    const st = await memberStatus(chatId, userId);
    const ok = st === 'creator' || st === 'administrator';
    adminCache.set(k, { at: now(), ok });
    return ok;
  }

  // ----- «бан везде» -----
  async function bannedSet(fresh = false) {
    if (!fresh && now() - bannedCache.at < 60_000) return bannedCache.set;
    const keys = await deps.dbGet(`${GLOBAL}/bans`, { shallow: true }).catch(() => undefined);
    if (keys === undefined) return bannedCache.set; // база не ответила — остаёмся при прежнем списке
    bannedCache = { at: now(), set: new Set(Object.keys(keys || {}).filter((k) => userKeyOf(k))) };
    return bannedCache.set;
  }
  async function listEnabledChats() {
    const idx = await deps.dbGet(`${GLOBAL}/chats`).catch(() => null);
    return Object.keys(idx && typeof idx === 'object' ? idx : {}).filter((k) => chatKeyOf(k)).slice(0, 40);
  }
  // по пять запросов к Telegram одновременно: у Worker'а лимит подзапросов на одно обращение
  async function eachChat(chats, fn) {
    const out = [];
    for (let i = 0; i < chats.length; i += 5) await Promise.all(chats.slice(i, i + 5).map(async (c) => { out.push(await fn(c)); }));
    return out;
  }
  function globalEvent(chatKey, at, action, actor, target, details) {
    return [`chatAdmin/${chatKey}/events/${dayKey(at)}/${eventId(at)}`, { t: 'mod', at, action, id: actor.id ? String(actor.id) : null, name: cleanText(actor.name, 60), target: { id: target.id, name: cleanText(target.name, 60) }, ...(details ? { details: cleanText(details, 200) } : {}) }];
  }
  // Человек из списка «бан везде» появился в чате (вошёл или написал) — блокируем сразу
  async function blockBanned(chatId, user) {
    const chatKey = chatKeyOf(chatId);
    const r = await deps.tg('banChatMember', { chat_id: chatId, user_id: Number(user.id) });
    const at = now();
    if (chatKey) { const [p, v] = globalEvent(chatKey, at, r.ok ? 'gban_block' : 'gban_block_failed', { id: null, name: 'Бан везде' }, { id: String(user.id), name: displayName(user) }, r.ok ? '' : explainTgError(r.description)); await deps.dbUpdate({ [p]: v }).catch(() => {}); }
    return r.ok;
  }

  // Забанить человека везде: во всех включённых чатах (в том числе тех, где его ещё нет — он не сможет зайти), в игре и в ВидеоЧате.
  // Возвращает { ok, text, chats:[{chat, ok, error}], game, videochat }.
  async function globalBan(target, opts = {}, actor = { id: null, name: 'панель' }) {
    const uid = userKeyOf(target && target.id);
    if (!uid || uid.length < 5) return { ok: false, text: 'Нужен числовой Telegram-id человека (5–15 цифр).' };
    if (owners.has(uid) || uid === String(deps.botId)) return { ok: false, text: 'Это владелец проекта или сам бот — нельзя.' };
    const role = deps.roleOf ? await deps.roleOf(uid).catch(() => null) : null;
    if (role === 'admin' || role === 'superadmin') return { ok: false, text: 'Это админ проекта — сначала снимите ему роль.' };
    const reason = cleanText(opts.reason, 200);
    const name = cleanText(target.name, 60) || uid;
    const username = target.username ? cleanText(target.username, 40) : '';
    const chats = await listEnabledChats();
    const results = await eachChat(chats, async (c) => {
      const r = await deps.tg('banChatMember', { chat_id: Number(c), user_id: Number(uid) });
      return { chat: c, ok: !!r.ok, error: r.ok ? null : explainTgError(r.description) };
    });
    let game = 'none';
    if (deps.gameBan) { try { game = await deps.gameBan(uid); } catch { game = 'error'; } }
    let videochat = false;
    if (deps.videochatBan) { try { await deps.videochatBan(uid, reason, actor.name); videochat = true; } catch { videochat = false; } }
    const existing = await deps.dbGet(`${GLOBAL}/bans/${uid}`).catch(() => null);
    const at = now();
    const okN = results.filter((r) => r.ok).length;
    const rec = { at: existing && existing.at ? existing.at : at, by: actor.id ? String(actor.id) : null, byName: cleanText(actor.name, 60), reason, name,
      game: existing && existing.game === 'banned' ? 'banned' : game, videochat, chats: { ok: okN, fail: results.length - okN } };
    if (username) rec.username = username;
    const w = { [`${GLOBAL}/bans/${uid}`]: rec };
    for (const r of results.filter((x) => x.ok)) { const [p, v] = globalEvent(r.chat, at, 'gban', actor, { id: uid, name }, reason); w[p] = v; }
    await deps.dbUpdate(w);
    bannedCache.set.add(uid);
    const gameText = { banned: 'в игре заблокирован', already: 'в игре уже был заблокирован', none: 'в игре его нет (профиля не найдено)', error: 'в игре не получилось' }[rec.game] || '';
    const failed = results.filter((r) => !r.ok);
    return { ok: true, chats: results, game: rec.game, videochat,
      text: `🚫 ${name} заблокирован везде: чатов ${okN} из ${results.length}, ${gameText}, ВидеоЧат ${videochat ? 'закрыт' : 'не получилось'}.` + (failed.length ? '\n⚠️ В ' + failed.length + ' чат(ах) не вышло: ' + [...new Set(failed.map((f) => f.error))].join('; ') : '') + (results.length === 0 ? '\nВключённых чатов пока нет — бан действует только в игре и ВидеоЧате.' : '') };
  }
  async function globalUnban(target, actor = { id: null, name: 'панель' }) {
    const uid = userKeyOf(target && target.id);
    if (!uid) return { ok: false, text: 'Нужен числовой Telegram-id.' };
    const rec = await deps.dbGet(`${GLOBAL}/bans/${uid}`).catch(() => null);
    if (!rec) return { ok: false, text: 'Этого человека нет в списке «бан везде».' };
    const chats = await listEnabledChats();
    const results = await eachChat(chats, async (c) => {
      const r = await deps.tg('unbanChatMember', { chat_id: Number(c), user_id: Number(uid), only_if_banned: true });
      return { chat: c, ok: !!r.ok };
    });
    // в игре снимаем бан, только если его ставили мы (а не он был забанен за другое до этого)
    if (rec.game === 'banned' && deps.gameUnban) { try { await deps.gameUnban(uid); } catch { /* останется — снимут вручную */ } }
    if (deps.videochatUnban) { try { await deps.videochatUnban(uid); } catch { /* то же */ } }
    const at = now();
    const name = cleanText(rec.name, 60) || uid;
    const w = { [`${GLOBAL}/bans/${uid}`]: null };
    for (const r of results.filter((x) => x.ok)) { const [p, v] = globalEvent(r.chat, at, 'ungban', actor, { id: uid, name }, ''); w[p] = v; }
    await deps.dbUpdate(w);
    bannedCache.set.delete(uid);
    return { ok: true, text: `✅ ${name}: бан везде снят (чатов ${results.filter((r) => r.ok).length}${rec.game === 'banned' ? ', игра разблокирована' : ''}).` };
  }

  // ----- проверка «я не бот» -----
  // Новичок сразу ограничен (не может писать), ему приходит кнопка. Нажал — права возвращаются; не нажал за captchaSec секунд — выгоняем
  // (может зайти снова). Ограничить не получилось (нет права / это админ) — впускаем как раньше, без проверки.
  const escHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  async function defaultPerms(chatId) {
    const r = await deps.tg('getChat', { chat_id: chatId }).catch(() => null);
    const src = r && r.ok && r.result && r.result.permissions;
    const out = {};
    for (const k of Object.keys(ALL_FALSE)) out[k] = src ? !!src[k] : !['can_change_info', 'can_pin_messages', 'can_manage_topics'].includes(k);
    return out;
  }
  const captchaEvent = (chatKey, at, action, target) => globalEvent(chatKey, at, action, { id: null, name: 'Проверка «я не бот»' }, target, '');
  const captchaSecOf = (cfg) => { const n = Number(cfg.captchaSec); return Number.isFinite(n) ? Math.min(600, Math.max(10, Math.round(n))) : 10; };
  async function startCaptcha(chat, user, ev, cfg) {
    const chatKey = chatKeyOf(chat.id);
    const uid = userKeyOf(user.id);
    if (!chatKey || !uid || owners.has(uid) || user.is_bot) return false;
    if (ev.how === 'request') return false; // заявку уже одобрил администратор
    if (ev.how === 'added' && ev.by && await isChatAdmin(chat.id, ev.by.id)) return false; // добавил администратор
    if (await deps.dbGet(`chatAdmin/${chatKey}/users/${uid}/verifiedAt`).catch(() => null)) return false; // уже проходил проверку
    const r = await deps.tg('restrictChatMember', { chat_id: chat.id, user_id: Number(user.id), permissions: ALL_FALSE, use_independent_chat_permissions: true });
    if (!r.ok) return false;
    const secs = captchaSecOf(cfg);
    const name = displayName(user);
    const sent = await deps.tg('sendMessage', {
      chat_id: chat.id, parse_mode: 'HTML',
      text: `👋 <a href="tg://user?id=${uid}">${escHtml(name)}</a>, добро пожаловать в «${escHtml(cleanText(chat.title, 60) || 'чат')}»!\n\nНажмите кнопку ниже — так мы убедимся, что вы человек, а не бот. На это ${secs} сек., иначе придётся зайти заново.`,
      reply_markup: { inline_keyboard: [[{ text: '✅ Я не бот', callback_data: 'cap:' + uid }]] },
    });
    const msgId = sent && sent.ok && sent.result ? sent.result.message_id : null;
    const lift = async () => { const perms = await defaultPerms(chat.id); await deps.tg('restrictChatMember', { chat_id: chat.id, user_id: Number(user.id), permissions: perms, use_independent_chat_permissions: true }); };
    if (!msgId) { await lift().catch(() => {}); return false; } // без кнопки человек остался бы немым навсегда
    try { await deps.dbUpdate({ [`chatAdmin/${chatKey}/pending/${uid}`]: { at: now(), until: now() + secs * 1000, msgId, name } }); }
    catch { await deps.tg('deleteMessage', { chat_id: chat.id, message_id: msgId }); await lift().catch(() => {}); return false; }
    return true;
  }
  async function sendWelcome(chat, user, cfg) {
    if (!cfg.welcome) return;
    const text = (cfg.welcomeText || 'Привет, {name}! Добро пожаловать в «{chat}». Правила чата — /rules')
      .replace(/\{name\}/g, displayName(user)).replace(/\{chat\}/g, cleanText(chat.title, 60) || 'чат');
    await say(chat.id, text);
  }
  // Нажатие кнопки «Я не бот». true — это наша кнопка (дальше по цепочке не идёт).
  async function onCallback(query) {
    const m = /^cap:(\d{1,15})$/.exec(String(query && query.data || ''));
    if (!m) return false;
    const uid = m[1];
    const answer = (text, alert = false) => deps.tg('answerCallbackQuery', { callback_query_id: query.id, text, show_alert: alert });
    const chat = query.message && query.message.chat;
    const chatKey = chat ? chatKeyOf(chat.id) : null;
    const meta = chatKey ? await getMeta(chatKey) : null;
    if (!meta || !meta.enabled) { await answer('Проверка уже не нужна.'); return true; }
    if (String(query.from && query.from.id) !== uid) { await answer('Эта кнопка для новичка — она не ваша.'); return true; }
    const p = await deps.dbGet(`chatAdmin/${chatKey}/pending/${uid}`).catch(() => undefined);
    if (p === undefined) { await answer('Не получилось проверить. Нажмите ещё раз.'); return true; }
    if (!p || p.kicked) {
      await answer('Время проверки вышло. Зайдите в чат заново.', true);
      await deps.tg('deleteMessage', { chat_id: chat.id, message_id: query.message.message_id });
      return true;
    }
    const perms = await defaultPerms(chat.id);
    const r = await deps.tg('restrictChatMember', { chat_id: chat.id, user_id: Number(uid), permissions: perms, use_independent_chat_permissions: true });
    if (!r.ok) { await answer('Не получилось снять ограничение — попросите администратора чата.', true); return true; }
    const at = now();
    const name = cleanText(p.name, 60) || displayName(query.from);
    const [ep, ev] = captchaEvent(chatKey, at, 'captcha_pass', { id: uid, name });
    await deps.dbUpdate({ [`chatAdmin/${chatKey}/pending/${uid}`]: null, [`chatAdmin/${chatKey}/users/${uid}/verifiedAt`]: at, [`chatAdmin/${chatKey}/daily/${dayKey(at)}/captcha_ok`]: inc(), [ep]: ev }).catch(() => {});
    await deps.tg('deleteMessage', { chat_id: chat.id, message_id: query.message.message_id });
    await answer('✅ Готово, добро пожаловать!');
    await sendWelcome(chat, query.from, cfgOf(meta));
    return true;
  }
  // Выгнать тех, кто не нажал кнопку вовремя. Возвращает, сколько человек выгнано. Не чаще раза в 30 с на чат (force — всегда).
  async function sweepCaptcha(chatKey, force = false) {
    if (!chatKeyOf(chatKey)) return 0;
    if (!force && now() - (sweepAt.get(chatKey) || 0) < 30_000) return 0;
    sweepAt.set(chatKey, now());
    const pend = await deps.dbGet(`chatAdmin/${chatKey}/pending`).catch(() => null);
    if (!pend || typeof pend !== 'object') return 0;
    let n = 0;
    for (const [uid, p] of Object.entries(pend)) {
      if (!userKeyOf(uid) || !p || typeof p !== 'object') continue;
      if (p.kicked) { if (now() - Number(p.kicked) > 10 * 60_000) await deps.dbUpdate({ [`chatAdmin/${chatKey}/pending/${uid}`]: null }).catch(() => {}); continue; }
      if (Number(p.until) > now()) continue;
      if (n >= 8) break; // у Worker'а лимит подзапросов на одно обращение — остальных выгоним в следующий раз
      n += 1;
      const chatId = Number(chatKey);
      await deps.dbUpdate({ [`chatAdmin/${chatKey}/pending/${uid}/kicked`]: now() }); // отметка: «бан/разбан» от этого выгоняния в статистику не идут
      const b = await deps.tg('banChatMember', { chat_id: chatId, user_id: Number(uid), revoke_messages: false });
      const at = now();
      const name = cleanText(p.name, 60) || uid;
      if (b.ok) {
        await deps.tg('unbanChatMember', { chat_id: chatId, user_id: Number(uid), only_if_banned: true });
        const [ep, ev] = captchaEvent(chatKey, at, 'captcha_fail', { id: uid, name });
        await deps.dbUpdate({ [`chatAdmin/${chatKey}/users/${uid}/status`]: 'left', [`chatAdmin/${chatKey}/users/${uid}/leftAt`]: at, [`chatAdmin/${chatKey}/daily/${dayKey(at)}/captcha_fail`]: inc(), [ep]: ev }).catch(() => {});
      } else {
        // не можем выгнать (право отозвали) — чтобы человек не остался немым навсегда, возвращаем права
        const perms = await defaultPerms(chatId);
        await deps.tg('restrictChatMember', { chat_id: chatId, user_id: Number(uid), permissions: perms, use_independent_chat_permissions: true });
        await deps.dbUpdate({ [`chatAdmin/${chatKey}/pending/${uid}`]: null }).catch(() => {});
      }
      if (p.msgId) await deps.tg('deleteMessage', { chat_id: chatId, message_id: p.msgId });
    }
    return n;
  }
  // Раз в минуту (cron Worker'а): пройтись по включённым чатам. Возвращает, сколько человек выгнано.
  async function sweepAll() {
    let total = 0;
    for (const c of (await listEnabledChats()).slice(0, 20)) {
      const meta = await getMeta(c);
      if (!meta || !meta.enabled || !cfgOf(meta).captcha) continue;
      total += await sweepCaptcha(c, true).catch(() => 0);
    }
    return total;
  }

  // ----- запись событий -----
  async function maybePrune(chatKey, meta) {
    const today = dayKey(now());
    if (!meta || meta.prunedDay === today) return;
    metaCache.set(chatKey, { at: now(), meta: { ...meta, prunedDay: today } });
    try {
      await deps.dbUpdate({ [`chatAdmin/${chatKey}/meta/prunedDay`]: today });
      for (const [node, keep] of [['events', EVENTS_KEEP_DAYS], ['daily', DAILY_KEEP_DAYS]]) {
        const keys = await deps.dbGet(`chatAdmin/${chatKey}/${node}`, { shallow: true });
        if (!keys || typeof keys !== 'object') continue;
        const cutoff = dayKey(now() - keep * DAY_MS);
        const del = {};
        for (const d of Object.keys(keys)) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff) del[`chatAdmin/${chatKey}/${node}/${d}`] = null;
        if (Object.keys(del).length) await deps.dbUpdate(del);
      }
    } catch { /* уборка — не главное: повторим завтра */ }
  }

  async function recordEvent(chatKey, ev) {
    let linkId = null;
    if (ev.link) linkId = await sha1hex(ev.link.raw);
    await deps.dbUpdate(eventWrites(chatKey, ev, linkId));
    await maybePrune(chatKey, (metaCache.get(chatKey) || {}).meta);
  }

  // ----- вход и выход людей (обновление chat_member) -----
  async function onChatMember(update) {
    const chat = update.chat_member && update.chat_member.chat;
    const chatKey = chat ? chatKeyOf(chat.id) : null;
    if (!chatKey) return;
    const meta = await getMeta(chatKey);
    if (!meta || !meta.enabled) return;
    const ev = describeChatMember(update);
    if (!ev || !userKeyOf(ev.user.id)) return;
    if (ev.user.is_bot && (ev.kind !== 'join' || String(ev.user.id) === String(deps.botId))) return;
    if (ev.kind === 'join' && (await bannedSet()).has(String(ev.user.id))) { await blockBanned(chat.id, ev.user); return; } // «бан везде»: не впускаем, статистику не пачкаем
    const cfg = cfgOf(meta);
    if (cfg.captcha) await sweepCaptcha(chatKey).catch(() => 0); // заодно выгоняем тех, кто не нажал кнопку вовремя
    if (ev.kind !== 'join') {
      // человек ушёл (или его убрали) во время проверки «я не бот»: убираем кнопку; если это сделали мы сами — в статистику «бан» не пишем
      const p = cfg.captcha ? await deps.dbGet(`chatAdmin/${chatKey}/pending/${ev.user.id}`).catch(() => null) : null;
      if (p && typeof p === 'object') {
        if (!p.kicked && p.msgId) await deps.tg('deleteMessage', { chat_id: chat.id, message_id: p.msgId });
        if (!p.kicked || ev.kind === 'unban') await deps.dbUpdate({ [`chatAdmin/${chatKey}/pending/${ev.user.id}`]: null }).catch(() => {});
        if (p.kicked && (ev.kind === 'ban' || ev.kind === 'removed' || ev.kind === 'unban')) return;
      }
    }
    await recordEvent(chatKey, ev);
    if (ev.kind === 'join' && !ev.user.is_bot) {
      let challenged = false;
      if (cfg.captcha) { try { challenged = await startCaptcha(chat, ev.user, ev, cfg); } catch { challenged = false; } }
      if (!challenged) await sendWelcome(chat, ev.user, cfg); // с проверкой приветствие будет после неё
      else return { sweepChat: chatKey, sweepInMs: captchaSecOf(cfg) * 1000 + 500 }; // Worker подождёт и выгонит ровно по сроку (cron — раз в минуту)
    }
  }

  // ----- бот добавлен / сделан администратором / удалён (my_chat_member) -----
  async function onMyChatMember(update) {
    const u = update.my_chat_member;
    const chat = u && u.chat;
    if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return;
    const chatKey = chatKeyOf(chat.id);
    if (!chatKey || !u.new_chat_member) return;
    const status = u.new_chat_member.status;
    const meta = await getMeta(chatKey, true);
    if (meta && meta.enabled) {
      await deps.dbUpdate({ [`chatAdmin/${chatKey}/meta/botStatus`]: status, [`chatAdmin/${chatKey}/meta/title`]: cleanText(chat.title, 80) });
      metaCache.delete(chatKey);
    } else if ((status === 'administrator') && u.from && owners.has(String(u.from.id))) {
      await say(chat.id, '✅ Теперь я администратор этого чата. Чтобы включить статистику входов и модерацию, отправьте /admin_on (это может сделать только владелец проекта).');
    }
  }

  // ----- сообщения -----
  async function resolveTarget(msg, args) {
    const rep = msg.reply_to_message;
    if (rep && rep.from && !rep.sender_chat) return { id: String(rep.from.id), name: displayName(rep.from), user: rep.from, msgId: rep.message_id, rest: args };
    const ent = (msg.entities || []).find((e) => e.type === 'text_mention' && e.user);
    if (ent) return { id: String(ent.user.id), name: displayName(ent.user), user: ent.user, rest: args };
    const m = /^(\d{5,15})\b\s*([\s\S]*)$/.exec(args);
    if (m) return { id: m[1], name: m[1], rest: m[2] };
    return null;
  }

  async function logMod(chatKey, actor, action, target, details) {
    const at = now();
    const day = dayKey(at);
    const w = {};
    w[`chatAdmin/${chatKey}/events/${day}/${eventId(at)}`] = {
      t: 'mod', at, action, id: actor.id ? String(actor.id) : null, name: cleanText(actor.name, 60),
      ...(target ? { target: { id: target.id, name: cleanText(target.name, 60) } } : {}), ...(details ? { details: cleanText(details, 200) } : {}),
    };
    w[`chatAdmin/${chatKey}/daily/${day}/mod_${action}`] = inc();
    if (target && userKeyOf(target.id)) {
      if (action === 'ban') w[`chatAdmin/${chatKey}/users/${target.id}/status`] = 'banned';
      if (action === 'unban') w[`chatAdmin/${chatKey}/users/${target.id}/status`] = 'left';
    }
    await deps.dbUpdate(w).catch(() => {});
  }

  // Действие модерации. Одно и то же из команд в чате и из панели (actor — кто просил). Возвращает { ok, text }.
  async function act(chatId, action, target, opts = {}, actor = { id: null, name: 'панель' }) {
    const chatKey = chatKeyOf(chatId);
    if (!chatKey) return { ok: false, text: 'Неверный чат.' };
    const t = target && userKeyOf(target.id) ? target : null;
    if (!t && action !== 'del' && action !== 'pin' && action !== 'unpin') return { ok: false, text: 'Не понял, к кому это применить.' };
    if (t && (owners.has(t.id) || String(t.id) === String(deps.botId))) return { ok: false, text: 'Это владелец проекта или сам бот — нельзя.' };
    if (t && ['ban', 'kick', 'mute', 'warn'].includes(action)) {
      const st = await memberStatus(chatId, t.id);
      if (st === 'creator' || st === 'administrator') return { ok: false, text: 'Это администратор чата — нельзя.' };
    }
    const fail = (r) => ({ ok: false, text: explainTgError(r && r.description) });
    const who = t ? t.name : '';
    if (action === 'ban') {
      const r = await deps.tg('banChatMember', { chat_id: chatId, user_id: Number(t.id) });
      if (!r.ok) return fail(r);
      await logMod(chatKey, actor, 'ban', t, opts.reason);
      return { ok: true, text: `🚫 ${who} заблокирован.${opts.reason ? ' Причина: ' + cleanText(opts.reason, 100) : ''}` };
    }
    if (action === 'unban') {
      const r = await deps.tg('unbanChatMember', { chat_id: chatId, user_id: Number(t.id), only_if_banned: true });
      if (!r.ok) return fail(r);
      await logMod(chatKey, actor, 'unban', t);
      return { ok: true, text: `✅ ${who} разблокирован (может зайти снова).` };
    }
    if (action === 'kick') {
      const r = await deps.tg('banChatMember', { chat_id: chatId, user_id: Number(t.id) });
      if (!r.ok) return fail(r);
      await deps.tg('unbanChatMember', { chat_id: chatId, user_id: Number(t.id), only_if_banned: true });
      await logMod(chatKey, actor, 'kick', t, opts.reason);
      return { ok: true, text: `👢 ${who} удалён из чата (может зайти снова).` };
    }
    if (action === 'mute') {
      const sec = opts.seconds || 3600;
      const r = await deps.tg('restrictChatMember', { chat_id: chatId, user_id: Number(t.id), permissions: ALL_FALSE, until_date: Math.floor(now() / 1000) + sec, use_independent_chat_permissions: false });
      if (!r.ok) return fail(r);
      await logMod(chatKey, actor, 'mute', t, formatDuration(sec) + (opts.reason ? ' · ' + opts.reason : ''));
      return { ok: true, text: `🔇 ${who} не может писать ${formatDuration(sec)}.` };
    }
    if (action === 'unmute') {
      const chat = await deps.tg('getChat', { chat_id: chatId });
      const perms = chat && chat.ok && chat.result && chat.result.permissions ? { ...ALL_TRUE, ...chat.result.permissions } : ALL_TRUE;
      const r = await deps.tg('restrictChatMember', { chat_id: chatId, user_id: Number(t.id), permissions: perms, use_independent_chat_permissions: false });
      if (!r.ok) return fail(r);
      await logMod(chatKey, actor, 'unmute', t);
      return { ok: true, text: `🔊 ${who} снова может писать.` };
    }
    if (action === 'warn' || action === 'unwarn') {
      const meta = await getMeta(chatKey);
      const max = Math.min(Math.max(Number(cfgOf(meta).maxWarns) || 3, 1), 10);
      const cur = Number(await deps.dbGet(`chatAdmin/${chatKey}/users/${t.id}/warns`).catch(() => 0)) || 0;
      if (action === 'unwarn') {
        const next = Math.max(cur - 1, 0);
        await deps.dbUpdate({ [`chatAdmin/${chatKey}/users/${t.id}/warns`]: next });
        await logMod(chatKey, actor, 'unwarn', t);
        return { ok: true, text: `✅ У ${who} предупреждений: ${next}.` };
      }
      const next = cur + 1;
      if (next >= max) {
        const r = await deps.tg('restrictChatMember', { chat_id: chatId, user_id: Number(t.id), permissions: ALL_FALSE, until_date: Math.floor(now() / 1000) + 86400, use_independent_chat_permissions: false });
        await deps.dbUpdate({ [`chatAdmin/${chatKey}/users/${t.id}/warns`]: 0 });
        await logMod(chatKey, actor, 'warn', t, `${next}/${max} → мут на сутки` + (opts.reason ? ' · ' + opts.reason : ''));
        return r.ok ? { ok: true, text: `⚠️ ${who}: предупреждение ${next} из ${max} — мут на сутки.` } : fail(r);
      }
      await deps.dbUpdate({ [`chatAdmin/${chatKey}/users/${t.id}/warns`]: next });
      await logMod(chatKey, actor, 'warn', t, `${next}/${max}` + (opts.reason ? ' · ' + opts.reason : ''));
      return { ok: true, text: `⚠️ ${who}: предупреждение ${next} из ${max}.${opts.reason ? ' Причина: ' + cleanText(opts.reason, 100) : ''}` };
    }
    if (action === 'del') {
      if (!opts.messageId) return { ok: false, text: 'Ответьте командой на сообщение, которое нужно удалить.' };
      const r = await deps.tg('deleteMessage', { chat_id: chatId, message_id: opts.messageId });
      if (!r.ok) return fail(r);
      await logMod(chatKey, actor, 'del', t, '');
      return { ok: true, text: '' };
    }
    if (action === 'pin' || action === 'unpin') {
      if (action === 'pin' && !opts.messageId) return { ok: false, text: 'Ответьте командой на сообщение, которое нужно закрепить.' };
      const r = action === 'pin'
        ? await deps.tg('pinChatMessage', { chat_id: chatId, message_id: opts.messageId, disable_notification: true })
        : await deps.tg('unpinChatMessage', opts.messageId ? { chat_id: chatId, message_id: opts.messageId } : { chat_id: chatId });
      if (!r.ok) return fail(r);
      await logMod(chatKey, actor, action, null, '');
      return { ok: true, text: action === 'pin' ? '📌 Закреплено.' : 'Откреплено.' };
    }
    return { ok: false, text: 'Неизвестное действие.' };
  }

  // ----- статистика словами (для /stats, /top, /joins) -----
  function fmtWhen(ms, tz) {
    try { return new Date(ms).toLocaleString('ru-RU', { timeZone: tz || 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return new Date(ms).toISOString().slice(5, 16).replace('T', ' '); }
  }
  async function statsText(chatId, chatKey, title, tz) {
    const daily = (await deps.dbGet(`chatAdmin/${chatKey}/daily`).catch(() => null)) || {};
    const sum = (days, key) => days.reduce((a, d) => a + (Number(daily[d] && daily[d][key]) || 0), 0);
    const daysBack = (n) => Array.from({ length: n }, (_, i) => dayKey(now() - i * DAY_MS));
    const d1 = daysBack(1); const d7 = daysBack(7); const d30 = daysBack(30);
    const cnt = await deps.tg('getChatMemberCount', { chat_id: chatId });
    const how = Object.keys(HOW_LABELS).map((h) => [h, sum(d30, 'how_' + h)]).filter(([, n]) => n > 0).map(([h, n]) => `${HOW_LABELS[h]}: ${n}`);
    const links = (await deps.dbGet(`chatAdmin/${chatKey}/links`).catch(() => null)) || {};
    const topLinks = Object.values(links).filter((l) => l && l.joins).sort((a, b) => b.joins - a.joins).slice(0, 3).map((l) => `«${cleanText(l.name, 30)}» — ${l.joins}`);
    return [
      `📊 «${cleanText(title, 50)}»`,
      cnt && cnt.ok ? `Участников: ${cnt.result}` : null,
      `Сегодня: +${sum(d1, 'joins')} / −${sum(d1, 'leaves')}, сообщений ${sum(d1, 'messages')}`,
      `За 7 дней: +${sum(d7, 'joins')} / −${sum(d7, 'leaves')}, сообщений ${sum(d7, 'messages')}`,
      `За 30 дней вошли: ${sum(d30, 'joins')}` + (how.length ? ' (' + how.join('; ') + ')' : ''),
      topLinks.length ? 'Ссылки: ' + topLinks.join(', ') : null,
      'Подробнее — в админ-панели.',
    ].filter(Boolean).join('\n');
  }
  async function topText(chatKey) {
    const users = (await deps.dbGet(`chatAdmin/${chatKey}/users`).catch(() => null)) || {};
    const rows = Object.entries(users).filter(([, u]) => u && u.messages).sort((a, b) => b[1].messages - a[1].messages).slice(0, 10);
    if (!rows.length) return 'Пока нет данных: статистика собирается с тех пор, как включены админ-функции.';
    return '🏆 Самые активные (по числу сообщений)\n' + rows.map(([, u], i) => `${i + 1}. ${cleanText(u.name, 40)}${u.username ? ' (@' + u.username + ')' : ''} — ${u.messages}`).join('\n');
  }
  async function joinsText(chatKey, tz) {
    const out = [];
    for (let i = 0; i < 14 && out.length < 10; i++) {
      const day = await deps.dbGet(`chatAdmin/${chatKey}/events/${dayKey(now() - i * DAY_MS)}`).catch(() => null);
      if (!day) continue;
      const rows = Object.values(day).filter((e) => e && e.t === 'join').sort((a, b) => b.at - a.at);
      for (const e of rows) { if (out.length < 10) out.push(`${fmtWhen(e.at, tz)} — ${cleanText(e.name, 40)}${e.username ? ' (@' + e.username + ')' : ''}, ${howText(e.how, e.link, e.by)}`); }
    }
    return out.length ? '🚪 Последние входы\n' + out.join('\n') : 'Входов пока не записано (бот должен быть администратором чата).';
  }
  function settingsText(meta) {
    const c = cfgOf(meta);
    const on = (v) => (v ? 'включено' : 'выключено');
    return ['⚙️ Настройки чата', `welcome — приветствие новичков: ${on(c.welcome)}`, `links — удалять ссылки у обычных участников: ${on(c.links)}`, `cleanup — удалять служебные «вошёл/вышел»: ${on(c.cleanup)}`,
      `captcha — проверка «я не бот» для новичков: ${on(c.captcha)} (captchaSec — секунд на ответ: ${c.captchaSec})`, `count — считать сообщения (только счётчик): ${on(c.count)}`, `maxWarns — предупреждений до мута: ${c.maxWarns}`, `tz — часовой пояс: ${c.tz}`, '', 'Менять: /set <ключ> on|off (или число). Приветствие: /setwelcome текст ({name}, {chat}). Правила: /setrules текст.'].join('\n');
  }

  const HELP = [
    '🤖 Команды администратора чата:',
    '/stats — статистика · /top — активные · /joins — кто и как заходил',
    '/ban, /unban, /kick, /mute [мин|2h|1d], /unmute — ответом на сообщение (или по числовому id)',
    '/warn, /unwarn — предупреждения · /del — удалить сообщение · /pin, /unpin',
    '/settings, /set, /setwelcome, /setrules — настройки · /rules — правила',
    'Проверка «я не бот» для новичков: /set captcha on|off, /set captchaSec 10–600 (секунд на нажатие кнопки)',
    'Только владелец проекта: /gban и /ungban — забанить или разбанить человека везде (все чаты, игра, ВидеоЧат)',
    'Видеозвонки: /call, /connect',
  ].join('\n');

  async function setCfg(chatKey, meta, key, value) {
    await deps.dbUpdate({ [`chatAdmin/${chatKey}/meta/cfg/${key}`]: value });
    metaCache.delete(chatKey);
  }
  // Применить настройку (из команды или панели): возвращает текст про результат
  async function applySetting(chatKey, meta, key, raw) {
    const kind = CFG_KEYS[key];
    if (!kind) return { ok: false, text: 'Такой настройки нет. Доступно: ' + Object.keys(CFG_KEYS).join(', ') };
    let v;
    if (kind === 'bool') {
      const t = String(raw).toLowerCase();
      if (['on', 'вкл', '1', 'true', 'да'].includes(t)) v = true; else if (['off', 'выкл', '0', 'false', 'нет'].includes(t)) v = false; else return { ok: false, text: 'Нужно on или off.' };
    } else if (kind === 'text') {
      v = cleanText(raw, key === 'rules' ? 1500 : 500);
    } else if (kind === 'num') {
      v = Number(raw);
      if (key === 'captchaSec') { if (!Number.isInteger(v) || v < 10 || v > 600) return { ok: false, text: 'Нужно число секунд от 10 до 600.' }; }
      else if (!Number.isInteger(v) || v < 1 || v > 10) return { ok: false, text: 'Нужно число от 1 до 10.' };
    } else {
      v = String(raw).trim(); try { new Date().toLocaleString('ru-RU', { timeZone: v }); } catch { return { ok: false, text: 'Не знаю такой часовой пояс (пример: Europe/Berlin).' }; }
    }
    await setCfg(chatKey, meta, key, v);
    return { ok: true, text: `Готово: ${key} = ${v === true ? 'включено' : v === false ? 'выключено' : v}.` };
  }

  async function disable(chatKey) {
    await deps.dbUpdate({ [`chatAdmin/${chatKey}/meta/enabled`]: false, [`${GLOBAL}/chats/${chatKey}`]: null });
    metaCache.delete(chatKey);
  }
  async function enable(chat, from) {
    const chatKey = chatKeyOf(chat.id);
    const botSt = await memberStatus(chat.id, deps.botId);
    const old = await getMeta(chatKey, true);
    const meta = { enabled: true, title: cleanText(chat.title, 80), type: chat.type, enabledAt: old && old.enabledAt ? old.enabledAt : now(), enabledBy: String(from.id), botStatus: botSt || 'unknown' };
    await deps.dbUpdate({ [`chatAdmin/${chatKey}/meta/enabled`]: true, [`chatAdmin/${chatKey}/meta/title`]: meta.title, [`chatAdmin/${chatKey}/meta/type`]: meta.type,
      [`chatAdmin/${chatKey}/meta/enabledAt`]: meta.enabledAt, [`chatAdmin/${chatKey}/meta/enabledBy`]: meta.enabledBy, [`chatAdmin/${chatKey}/meta/botStatus`]: meta.botStatus,
      [`${GLOBAL}/chats/${chatKey}`]: { title: meta.title } });
    metaCache.delete(chatKey);
    return botSt === 'administrator' || botSt === 'creator';
  }

  // Главный вход: сообщение в группе. true — сообщение обработано здесь (дальше по цепочке не идёт).
  async function onMessage(msg) {
    const chat = msg && msg.chat;
    if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return false;
    const chatKey = chatKeyOf(chat.id);
    if (!chatKey) return false;
    const fromId = msg.from && userKeyOf(msg.from.id);
    const text = typeof msg.text === 'string' ? msg.text : typeof msg.caption === 'string' ? msg.caption : '';
    const cmd = typeof msg.text === 'string' ? parseCommand(msg.text, deps.botUsername) : null;

    // включение и выключение — только владелец проекта (иначе любой чат мог бы заставить бота писать в базу)
    if (cmd && (cmd.name === 'admin_on' || cmd.name === 'admin_off')) {
      if (!fromId || !owners.has(fromId)) return true; // чужим не отвечаем
      if (cmd.name === 'admin_off') {
        await disable(chatKey);
        await say(chat.id, '⏹ Админ-функции для этого чата выключены. Собранная статистика сохранена.');
        return true;
      }
      const botAdmin = await enable(chat, msg.from);
      if (deps.onEnabled) { try { await deps.onEnabled(); } catch { /* вебхук проверит /health */ } }
      await say(chat.id, '✅ Админ-функции включены: статистика входов и сообщений, модерация. /help — список команд.'
        + (botAdmin ? '' : '\n\n⚠️ Сделайте меня администратором чата (права: удаление сообщений, блокировка участников, приглашение по ссылкам) — иначе я не увижу, кто и как заходит, и не смогу модерировать.'));
      return true;
    }

    const meta = await getMeta(chatKey);
    if (!meta || !meta.enabled) return false;
    const cfg = cfgOf(meta);
    if (cfg.captcha) await sweepCaptcha(chatKey).catch(() => 0);

    // «бан везде»: человек из списка вошёл (служебное сообщение) или написал — блокируем и убираем сообщение
    const banned = await bannedSet();
    if (banned.size) {
      const bad = (msg.new_chat_members || []).filter((u) => banned.has(String(u.id)));
      if (bad.length) { for (const u of bad) await blockBanned(chat.id, u); await deps.tg('deleteMessage', { chat_id: chat.id, message_id: msg.message_id }); return true; }
      if (fromId && banned.has(fromId) && !msg.from.is_bot) { await blockBanned(chat.id, msg.from); await deps.tg('deleteMessage', { chat_id: chat.id, message_id: msg.message_id }); return true; }
    }

    // служебные сообщения (вошёл/вышел) — убрать, если включено
    if (cfg.cleanup && (msg.new_chat_members || msg.left_chat_member)) { await deps.tg('deleteMessage', { chat_id: chat.id, message_id: msg.message_id }); return true; }
    if (!msg.from || msg.from.is_bot || msg.sender_chat || !fromId) return false;

    // счётчики сообщений (текст не сохраняется)
    if (cfg.count && !msg.new_chat_members && !msg.left_chat_member) {
      const at = now(); const day = dayKey(at);
      const w = {};
      w[`chatAdmin/${chatKey}/daily/${day}/messages`] = inc();
      w[`chatAdmin/${chatKey}/daily/${day}/hr/${String(new Date(at).getUTCHours()).padStart(2, '0')}`] = inc();
      w[`chatAdmin/${chatKey}/users/${fromId}/messages`] = inc();
      w[`chatAdmin/${chatKey}/users/${fromId}/lastSeen`] = at;
      w[`chatAdmin/${chatKey}/users/${fromId}/name`] = displayName(msg.from);
      w[`chatAdmin/${chatKey}/users/${fromId}/username`] = msg.from.username ? cleanText(msg.from.username, 40) : null;
      await deps.dbUpdate(w).catch(() => {});
      await maybePrune(chatKey, meta);
    }

    // ссылки у обычных участников
    if (!cmd && cfg.links && (msg.entities || msg.caption_entities || []).some((e) => e.type === 'url' || e.type === 'text_link')) {
      if (!(await isChatAdmin(chat.id, fromId))) {
        const r = await deps.tg('deleteMessage', { chat_id: chat.id, message_id: msg.message_id });
        if (r.ok && now() - (noticeAt.get(chatKey) || 0) > 60_000) { noticeAt.set(chatKey, now()); await say(chat.id, 'Ссылки в этом чате может отправлять только администрация.'); }
        return true;
      }
    }

    if (!cmd) return false;
    const publicCmds = ['rules', 'help'];
    const adminCmds = ['gban', 'ungban', 'stats', 'top', 'joins', 'ban', 'unban', 'kick', 'mute', 'unmute', 'warn', 'unwarn', 'del', 'pin', 'unpin', 'settings', 'set', 'setwelcome', 'setrules'];
    if (!publicCmds.includes(cmd.name) && !adminCmds.includes(cmd.name)) return false; // чужая команда (например /call) — дальше по цепочке
    if (cmd.name === 'rules') { await say(chat.id, cfg.rules ? '📜 Правила чата\n' + cfg.rules : 'Правила чата ещё не заданы (админ: /setrules текст).'); return true; }
    if (cmd.name === 'help') { await say(chat.id, HELP); return true; }
    if (!(await isChatAdmin(chat.id, fromId))) { await say(chat.id, 'Эта команда — для администраторов чата.'); return true; }
    const actor = { id: fromId, name: displayName(msg.from) };

    if (cmd.name === 'gban' || cmd.name === 'ungban') {
      if (!owners.has(fromId)) { await say(chat.id, 'Бан и разбан везде — только для владельца проекта.'); return true; }
      const tg = await resolveTarget(msg, cmd.args);
      if (!tg) { await say(chat.id, 'Ответьте этой командой на сообщение человека (или укажите его числовой id).'); return true; }
      const r = cmd.name === 'gban' ? await globalBan({ id: tg.id, name: tg.name, username: tg.user && tg.user.username }, { reason: tg.rest }, actor) : await globalUnban({ id: tg.id }, actor);
      await say(chat.id, r.text);
      return true;
    }

    if (cmd.name === 'stats') { await say(chat.id, await statsText(chat.id, chatKey, chat.title, cfg.tz)); return true; }
    if (cmd.name === 'top') { await say(chat.id, await topText(chatKey)); return true; }
    if (cmd.name === 'joins') { await say(chat.id, await joinsText(chatKey, cfg.tz)); return true; }
    if (cmd.name === 'settings') { await say(chat.id, settingsText(meta)); return true; }
    if (cmd.name === 'set') {
      const [k, ...v] = cmd.args.split(/\s+/);
      const r = k ? await applySetting(chatKey, meta, k, v.join(' ')) : { ok: false, text: settingsText(meta) };
      await say(chat.id, r.text); return true;
    }
    if (cmd.name === 'setwelcome') {
      if (!cmd.args) { await say(chat.id, 'Напишите текст после команды. Можно {name} и {chat}. Включить: /set welcome on'); return true; }
      await deps.dbUpdate({ [`chatAdmin/${chatKey}/meta/cfg/welcomeText`]: cleanText(cmd.args, 500), [`chatAdmin/${chatKey}/meta/cfg/welcome`]: true });
      metaCache.delete(chatKey); await say(chat.id, 'Приветствие сохранено и включено.'); return true;
    }
    if (cmd.name === 'setrules') {
      if (!cmd.args) { await say(chat.id, 'Напишите текст правил после команды.'); return true; }
      await deps.dbUpdate({ [`chatAdmin/${chatKey}/meta/cfg/rules`]: cleanText(cmd.args, 1500) });
      metaCache.delete(chatKey); await say(chat.id, 'Правила сохранены. Показать: /rules'); return true;
    }

    // действия над человеком / сообщением
    const target = await resolveTarget(msg, cmd.args);
    const rest = target ? target.rest : cmd.args;
    let opts = { reason: cleanText(rest, 200) };
    if (cmd.name === 'mute') {
      const first = String(rest || '').split(/\s+/)[0];
      const sec = parseDuration(first, 60);
      if (sec === null) { await say(chat.id, 'Не понял срок. Примеры: /mute 30, /mute 2h, /mute 1d'); return true; }
      opts = { seconds: sec, reason: cleanText(/^\d/.test(first) ? String(rest).slice(first.length) : rest, 200) };
    }
    if (cmd.name === 'del' || cmd.name === 'pin' || cmd.name === 'unpin') opts.messageId = msg.reply_to_message ? msg.reply_to_message.message_id : null;
    if (!target && !['del', 'pin', 'unpin'].includes(cmd.name)) { await say(chat.id, 'Ответьте этой командой на сообщение человека (или укажите его числовой id).'); return true; }
    const res = await act(chat.id, cmd.name, target, opts, actor);
    if (cmd.name === 'del' && res.ok) { await deps.tg('deleteMessage', { chat_id: chat.id, message_id: msg.message_id }); return true; }
    if (res.text) await say(chat.id, res.text);
    return true;
  }

  return { onMessage, onChatMember, onMyChatMember, onCallback, sweepCaptcha, sweepAll, act, applySetting, enable, disable, globalBan, globalUnban, getMeta, cfgOf, memberStatus, invalidate: (k) => metaCache.delete(k) };
}
