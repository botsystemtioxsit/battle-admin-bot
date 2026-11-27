// Проверка админ-бота чатов (src/chat-admin.mjs) на подставных Telegram и базе — без сети.
// Запуск: node cloudflare-worker/role-gateway/test/chat-admin.test.mjs
import {
  createChatAdmin, parseCommand, parseDuration, formatDuration, describeChatMember, eventWrites, dayKey, cleanText, explainTgError, isMember, DAY_MS,
} from '../src/chat-admin.mjs';

let bad = 0;
const t = (name, cond, extra) => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : JSON.stringify(extra)); if (!cond) bad++; };

// ---------- подставная база: дерево в памяти, пакетная запись с путями, increment и null ----------
function makeDb() {
  const root = {};
  const setPath = (path, value) => {
    const parts = path.split('/');
    let n = root;
    for (let i = 0; i < parts.length - 1; i++) { if (typeof n[parts[i]] !== 'object' || n[parts[i]] === null) n[parts[i]] = {}; n = n[parts[i]]; }
    const last = parts.at(-1);
    if (value === null) delete n[last];
    else if (value && typeof value === 'object' && value['.sv'] && value['.sv'].increment !== undefined) n[last] = (Number(n[last]) || 0) + value['.sv'].increment;
    else n[last] = value;
  };
  const get = (path) => path.split('/').reduce((n, k) => (n && typeof n === 'object' ? n[k] : undefined), root) ?? null;
  return {
    root, writes: [],
    async dbGet(path, o) { const v = get(path); return o && o.shallow && v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).map((k) => [k, true])) : v; },
    async dbUpdate(u) { this.writes.push(u); for (const [p, v] of Object.entries(u)) setPath(p, v); },
  };
}

const OWNER = '100', ADMIN = '200', USER = '300', VICTIM = '400', BOT = '7000000001';
const CHAT = -1001234567890;
const KEY = String(CHAT);
const NOW = Date.parse('2026-11-11T12:00:00Z');

function makeEnv({ owners = [OWNER], statuses = {}, tgOverrides = {}, roles = {}, gameState = 'banned' } = {}) {
  const db = makeDb();
  const calls = [];
  const side = { gameBan: [], gameUnban: [], vcBan: [], vcUnban: [], devBan: [], devUnban: [] };
  const clock = { t: NOW };
  const sent = () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text);
  const st = { [OWNER]: 'creator', [ADMIN]: 'administrator', [USER]: 'member', [VICTIM]: 'member', [BOT]: 'administrator', ...statuses };
  const deps = {
    tg: async (method, payload) => {
      calls.push({ method, payload });
      if (tgOverrides[method]) return tgOverrides[method](payload);
      if (method === 'getChatMember') { const s = st[String(payload.user_id)]; return s ? { ok: true, result: { status: s } } : { ok: false, description: 'Bad Request: user not found' }; }
      if (method === 'getChatMemberCount') return { ok: true, result: 42 };
      if (method === 'getChat') return { ok: true, result: { permissions: { can_send_messages: true, can_send_photos: true } } };
      if (method === 'sendMessage') return { ok: true, result: { message_id: 900 + calls.length } };
      return { ok: true, result: true };
    },
    dbGet: (p, o) => db.dbGet(p, o), dbUpdate: (u) => db.dbUpdate(u),
    owners: new Set(owners), botId: BOT, botUsername: 'my_bot', now: () => clock.t,
    roleOf: async (uid) => roles[uid] || null,
    gameBan: async (uid) => { side.gameBan.push(uid); return gameState; }, gameUnban: async (uid) => { side.gameUnban.push(uid); },
    videochatBan: async (uid, reason, by) => { side.vcBan.push({ uid, reason, by }); }, videochatUnban: async (uid) => { side.vcUnban.push(uid); },
    banDevices: async (uid) => { side.devBan.push(uid); return ['a'.repeat(24), 'b'.repeat(24)]; }, unbanDevices: async (uid, tags) => { side.devUnban.push({ uid, tags }); },
  };
  return { db, calls, sent, side, deps, clock, ca: createChatAdmin(deps) };
}
const msg = (from, text, extra = {}) => ({ message_id: 1, chat: { id: CHAT, type: 'supergroup', title: 'Наш чат' }, from: { id: Number(from), first_name: 'U' + from }, date: NOW / 1000, text, ...extra });
const reply = (to) => ({ reply_to_message: { message_id: 77, from: { id: Number(to), first_name: 'V' + to }, text: 'секретный текст сообщения' } });
const KEY_RE = /^chatAdmin(\/[A-Za-z0-9_-]{1,64}){0,8}$/; // тот же, что в Worker (CHAT_DB_PATH_RE)

// ---------- чистые функции ----------
t('команда: простая', JSON.stringify(parseCommand('/ban', 'my_bot')) === '{"name":"ban","args":""}');
t('команда: с именем своего бота и аргументами', JSON.stringify(parseCommand('/mute@My_Bot 30 спам  и флуд', 'my_bot')) === '{"name":"mute","args":"30 спам  и флуд"}');
t('команда: чужому боту — null', parseCommand('/ban@other_bot', 'my_bot') === null);
t('команда: не команда — null', parseCommand('привет /ban', 'my_bot') === null && parseCommand('/', 'my_bot') === null);
t('срок: по умолчанию, минуты, часы, дни, русские буквы', parseDuration('', 60) === 3600 && parseDuration('30') === 1800 && parseDuration('2h') === 7200 && parseDuration('1d') === 86400 && parseDuration('2ч') === 7200 && parseDuration('3д') === 259200);
t('срок: не меньше минуты, не больше 366 дней, мусор — null', parseDuration('0') === 60 && parseDuration('999999d') === 366 * 86400 && parseDuration('абв') === null);
t('срок словами', formatDuration(1800) === '30 мин.' && formatDuration(7200) === '2 ч.' && formatDuration(86400) === '1 дн.');
t('очистка текста: управляющие и RTL-знаки', cleanText('  а‮б\n\n в\u0000 ', 20) === 'а б в');
t('кто в чате: статусы', isMember({ status: 'member' }) && isMember({ status: 'restricted', is_member: true }) && !isMember({ status: 'restricted', is_member: false }) && !isMember({ status: 'left' }) && !isMember({ status: 'kicked' }));
t('ошибки Telegram понятно', explainTgError('Bad Request: not enough rights to restrict/unrestrict chat member').includes('нет нужного права') && explainTgError('Bad Request: user is an administrator of the chat').includes('администратор'));

const cm = (over) => ({ chat_member: { chat: { id: CHAT, type: 'supergroup', title: 'Наш чат' }, from: { id: 5, first_name: 'Кто-то' }, date: NOW / 1000,
  old_chat_member: { status: 'left', user: { id: 7, first_name: 'Вася' } }, new_chat_member: { status: 'member', user: { id: 7, first_name: 'Вася', username: 'vasya', language_code: 'de', is_premium: true } }, ...over } });
const same = (o) => ({ chat_member: { ...cm().chat_member, from: { id: 7, first_name: 'Вася' }, ...o } });
let ev = describeChatMember(same({ invite_link: { invite_link: 'https://t.me/+SECRETSECRET', name: 'Реклама  в канале', creator: { id: 1, first_name: 'Админ' } } }));
t('вход: по ссылке — название и создатель', ev.kind === 'join' && ev.how === 'invite' && ev.link.name === 'Реклама в канале' && ev.link.creator === 'Админ', ev);
ev = describeChatMember(same({ via_join_request: true }));
t('вход: по заявке', ev.how === 'request');
ev = describeChatMember(same({ via_chat_folder_invite_link: true }));
t('вход: по папке чатов', ev.how === 'folder');
ev = describeChatMember(cm());
t('вход: добавил участник (from ≠ user)', ev.how === 'added' && ev.by.id === '5' && ev.by.name === 'Кто-то', ev);
ev = describeChatMember(same({}));
t('вход: сам (без ссылки)', ev.how === 'direct' && ev.by === null);
ev = describeChatMember(same({ old_chat_member: { status: 'member', user: { id: 7 } }, new_chat_member: { status: 'left', user: { id: 7, first_name: 'Вася' } } }));
t('выход: сам', ev.kind === 'leave');
ev = describeChatMember(cm({ old_chat_member: { status: 'member', user: { id: 7 } }, new_chat_member: { status: 'left', user: { id: 7, first_name: 'Вася' } } }));
t('выход: удалил другой', ev.kind === 'removed' && ev.by.id === '5');
ev = describeChatMember(cm({ old_chat_member: { status: 'member', user: { id: 7 } }, new_chat_member: { status: 'kicked', user: { id: 7, first_name: 'Вася' } } }));
t('бан', ev.kind === 'ban');
ev = describeChatMember(cm({ old_chat_member: { status: 'kicked', user: { id: 7 } }, new_chat_member: { status: 'left', user: { id: 7, first_name: 'Вася' } } }));
t('разбан', ev.kind === 'unban');
t('повышение до админа и мут — не события', describeChatMember(cm({ old_chat_member: { status: 'member', user: { id: 7 } }, new_chat_member: { status: 'administrator', user: { id: 7 } } })) === null
  && describeChatMember(cm({ old_chat_member: { status: 'member', user: { id: 7 } }, new_chat_member: { status: 'restricted', is_member: true, user: { id: 7 } } })) === null);

const w = eventWrites(KEY, describeChatMember(same({ invite_link: { invite_link: 'https://t.me/+SECRETSECRET', name: 'Реклама' } })), 'abc123def456');
t('запись входа: ссылка НЕ хранится целиком', !JSON.stringify(w).includes('SECRETSECRET') && JSON.stringify(w).includes('abc123def456'));
t('запись входа: все пути проходят проверку Worker', Object.keys(w).every((p) => KEY_RE.test(p)), Object.keys(w).filter((p) => !KEY_RE.test(p)));
t('запись входа: счётчики дня, способ, ссылки, человек', w[`chatAdmin/${KEY}/daily/2026-11-11/joins`]['.sv'].increment === 1 && w[`chatAdmin/${KEY}/daily/2026-11-11/how_invite`] && w[`chatAdmin/${KEY}/links/abc123def456/joins`] && w[`chatAdmin/${KEY}/users/7/how`] === 'invite');

// ---------- включение и выключение ----------
{
  const e = makeEnv({ statuses: { [BOT]: 'member' } });
  let enabledHook = 0; e.deps.onEnabled = async () => { enabledHook++; };
  const ca = createChatAdmin(e.deps);
  let r = await ca.onMessage(msg(USER, '/admin_on'));
  t('включение: чужой — молчим и ничего не пишем', r === true && e.sent().length === 0 && e.db.writes.length === 0);
  r = await ca.onMessage(msg(OWNER, '/admin_on'));
  t('включение: владелец — meta записана, вебхук проверен', r === true && e.db.root.chatAdmin[KEY].meta.enabled === true && e.db.root.chatAdmin[KEY].meta.enabledBy === OWNER && enabledHook === 1, e.db.root);
  t('включение: бот не админ — предупреждение', e.sent().at(-1).includes('администратором'));
  r = await ca.onMessage(msg(OWNER, '/admin_off'));
  t('выключение: статистика остаётся', r === true && e.db.root.chatAdmin[KEY].meta.enabled === false && e.sent().at(-1).includes('выключены'));
}

// ---------- имя и @ник запоминаются при любом событии (поиск по участникам) ----------
{
  const e = await enabled({});
  const leave = (id, name, username) => ({ chat_member: { ...cm().chat_member, from: { id: Number(id), first_name: name }, old_chat_member: { status: 'member', user: { id: Number(id) } }, new_chat_member: { status: 'left', user: { id: Number(id), first_name: name, username } } } });
  await e.ca.onChatMember(leave(7, 'Вася', 'vasya_x'));
  const u = e.db.root.chatAdmin[KEY].users['7'];
  t('выход: имя и @ник запомнены (человека можно найти после ухода)', u && u.name === 'Вася' && u.username === 'vasya_x' && u.status === 'left', u);
  const ev = Object.values(Object.values(e.db.root.chatAdmin[KEY].events)[0])[0];
  t('событие выхода хранит id и @ник', ev.id === '7' && ev.username === 'vasya_x', ev);
}

// ---------- обычная работа в включённом чате ----------
async function enabled(extraMeta = {}, envOpts) {
  const e = makeEnv(envOpts);
  e.db.root.chatAdmin = { [KEY]: { meta: { enabled: true, title: 'Наш чат', enabledBy: OWNER, ...extraMeta } } };
  return e;
}
{
  const e = await enabled();
  let r = await e.ca.onMessage(msg(USER, 'привет всем, это мой приватный текст'));
  const dump = JSON.stringify(e.db.root);
  t('сообщение: считается, дальше по цепочке идёт', r === false && e.db.root.chatAdmin[KEY].daily['2026-11-11'].messages === 1 && e.db.root.chatAdmin[KEY].users[USER].messages === 1 && e.db.root.chatAdmin[KEY].daily['2026-11-11'].hr['12'] === 1);
  t('приватность: текст сообщения нигде не сохранён', !dump.includes('приватный текст'));
  await e.ca.onMessage(msg(USER, 'ещё'));
  t('сообщение: счётчик растёт', e.db.root.chatAdmin[KEY].users[USER].messages === 2);
  r = await e.ca.onMessage({ ...msg(USER, 'бот пишет'), from: { id: 5, is_bot: true, first_name: 'Бот' } });
  t('сообщения ботов не считаются', e.db.root.chatAdmin[KEY].users['5'] === undefined);
  r = await e.ca.onMessage(msg(USER, '/call'));
  t('чужая команда (/call) идёт дальше — на ВидеоЧат', r === false);
  r = await e.ca.onMessage(msg(USER, '/ban'));
  t('/ban от обычного участника — отказ без действий', r === true && e.sent().at(-1).includes('для администраторов') && !e.calls.some((c) => c.method === 'banChatMember'));
  r = await e.ca.onMessage(msg(USER, '/rules'));
  t('/rules доступно всем, пока правил нет — подсказка', r === true && e.sent().at(-1).includes('ещё не заданы'));
}
{
  const e = await enabled({}, {});
  // чат не включён — ничего не происходит
  const off = makeEnv();
  const r = await off.ca.onMessage(msg(USER, 'привет'));
  t('чат не включён: сообщение игнорируется, база не трогается', r === false && off.db.writes.length === 0 && off.calls.filter((c) => c.method !== 'getChatMember').length === 0);
  void e;
}

// ---------- модерация ----------
{
  const e = await enabled();
  let r = await e.ca.onMessage(msg(ADMIN, '/ban спам-бот', reply(VICTIM)));
  const ban = e.calls.find((c) => c.method === 'banChatMember');
  t('/ban ответом: бан выполнен, причина в ответе', ban && ban.payload.user_id === 400 && e.sent().at(-1).includes('заблокирован') && e.sent().at(-1).includes('спам-бот'), e.calls);
  const ev1 = Object.values(Object.values(e.db.root.chatAdmin[KEY].events)[0]).find((x) => x.t === 'mod');
  t('журнал: действие записано (кто, кого, причина)', ev1 && ev1.action === 'ban' && ev1.id === ADMIN && ev1.target.id === VICTIM && ev1.details === 'спам-бот', ev1);
  t('человек помечен заблокированным, счётчик банов', e.db.root.chatAdmin[KEY].users[VICTIM].status === 'banned' && e.db.root.chatAdmin[KEY].daily['2026-11-11'].mod_ban === 1);
  r = await e.ca.onMessage(msg(ADMIN, '/ban', reply(ADMIN)));
  t('нельзя банить администратора', !e.calls.filter((c) => c.method === 'banChatMember').some((c) => c.payload.user_id === 200) && e.sent().at(-1).includes('администратор'));
  r = await e.ca.onMessage(msg(ADMIN, '/ban', reply(OWNER)));
  t('нельзя банить владельца проекта', e.sent().at(-1).includes('владелец'));
  r = await e.ca.onMessage(msg(ADMIN, `/ban ${BOT}`));
  t('нельзя банить самого бота', e.sent().at(-1).includes('сам бот'));
  r = await e.ca.onMessage(msg(ADMIN, '/ban'));
  t('/ban без цели — подсказка', e.sent().at(-1).includes('Ответьте этой командой'));
  r = await e.ca.onMessage(msg(ADMIN, '/ban 12345678 по id'));
  t('/ban по числовому id', e.calls.filter((c) => c.method === 'banChatMember').some((c) => c.payload.user_id === 12345678));
  r = await e.ca.onMessage(msg(ADMIN, '/unban', reply(VICTIM)));
  t('/unban: разбан только если был забанен, статус снят', e.calls.find((c) => c.method === 'unbanChatMember').payload.only_if_banned === true && e.db.root.chatAdmin[KEY].users[VICTIM].status === 'left');
  r = await e.ca.onMessage(msg(ADMIN, '/kick', reply(VICTIM)));
  t('/kick = бан и сразу разбан', e.calls.filter((c) => c.method === 'unbanChatMember').length === 2 && e.sent().at(-1).includes('удалён'));

  r = await e.ca.onMessage(msg(ADMIN, '/mute 30 флуд', reply(VICTIM)));
  const mute = e.calls.filter((c) => c.method === 'restrictChatMember').at(-1);
  t('/mute 30: ограничение на 30 минут, все права выключены', mute.payload.until_date === NOW / 1000 + 1800 && mute.payload.permissions.can_send_messages === false && mute.payload.permissions.can_send_photos === false, mute);
  r = await e.ca.onMessage(msg(ADMIN, '/mute 2h', reply(VICTIM)));
  t('/mute 2h: 2 часа', e.calls.filter((c) => c.method === 'restrictChatMember').at(-1).payload.until_date === NOW / 1000 + 7200);
  r = await e.ca.onMessage(msg(ADMIN, '/mute', reply(VICTIM)));
  t('/mute без срока: час', e.calls.filter((c) => c.method === 'restrictChatMember').at(-1).payload.until_date === NOW / 1000 + 3600);
  r = await e.ca.onMessage(msg(ADMIN, '/mute абв', reply(VICTIM)));
  t('/mute с непонятным сроком — подсказка, без действия', e.sent().at(-1).includes('Не понял срок'));
  r = await e.ca.onMessage(msg(ADMIN, '/unmute', reply(VICTIM)));
  const un = e.calls.filter((c) => c.method === 'restrictChatMember').at(-1);
  t('/unmute: права как у чата по умолчанию', un.payload.permissions.can_send_messages === true && un.payload.until_date === undefined);

  e.db.root.chatAdmin[KEY].users[VICTIM].warns = 0;
  await e.ca.onMessage(msg(ADMIN, '/warn грубость', reply(VICTIM)));
  t('/warn 1 из 3', e.sent().at(-1).includes('1 из 3') && e.db.root.chatAdmin[KEY].users[VICTIM].warns === 1);
  await e.ca.onMessage(msg(ADMIN, '/warn', reply(VICTIM)));
  await e.ca.onMessage(msg(ADMIN, '/unwarn', reply(VICTIM)));
  t('/unwarn снимает одно', e.db.root.chatAdmin[KEY].users[VICTIM].warns === 1);
  await e.ca.onMessage(msg(ADMIN, '/warn', reply(VICTIM)));
  const before = e.calls.filter((c) => c.method === 'restrictChatMember').length;
  await e.ca.onMessage(msg(ADMIN, '/warn', reply(VICTIM)));
  const lastR = e.calls.filter((c) => c.method === 'restrictChatMember').at(-1);
  t('/warn 3 из 3: мут на сутки и сброс счётчика', e.calls.filter((c) => c.method === 'restrictChatMember').length === before + 1 && lastR.payload.until_date === NOW / 1000 + 86400 && e.db.root.chatAdmin[KEY].users[VICTIM].warns === 0 && e.sent().at(-1).includes('мут на сутки'));

  r = await e.ca.onMessage(msg(ADMIN, '/del', reply(VICTIM)));
  const dels = e.calls.filter((c) => c.method === 'deleteMessage');
  t('/del: удалено то сообщение и сама команда', dels.some((c) => c.payload.message_id === 77) && dels.some((c) => c.payload.message_id === 1));
  r = await e.ca.onMessage(msg(ADMIN, '/pin', reply(VICTIM)));
  t('/pin закрепляет без уведомления', e.calls.find((c) => c.method === 'pinChatMessage').payload.disable_notification === true);

  const denied = await enabled({}, { tgOverrides: { banChatMember: () => ({ ok: false, description: 'Bad Request: not enough rights to restrict/unrestrict chat member' }) } });
  await denied.ca.onMessage(msg(ADMIN, '/ban', reply(VICTIM)));
  t('нет прав у бота — понятное сообщение, события нет', denied.sent().at(-1).includes('нет нужного права') && !JSON.stringify(denied.db.root).includes('"action":"ban"'));
}

// ---------- настройки ----------
{
  const e = await enabled();
  await e.ca.onMessage(msg(ADMIN, '/set welcome on'));
  t('/set welcome on', e.db.root.chatAdmin[KEY].meta.cfg.welcome === true);
  await e.ca.onMessage(msg(ADMIN, '/set links выкл'));
  t('/set links выкл (по-русски)', e.db.root.chatAdmin[KEY].meta.cfg.links === false);
  await e.ca.onMessage(msg(ADMIN, '/set maxWarns 5'));
  t('/set maxWarns 5', e.db.root.chatAdmin[KEY].meta.cfg.maxWarns === 5);
  await e.ca.onMessage(msg(ADMIN, '/set maxWarns 99'));
  t('/set maxWarns 99 — отказ', e.sent().at(-1).includes('от 1 до 10') && e.db.root.chatAdmin[KEY].meta.cfg.maxWarns === 5);
  await e.ca.onMessage(msg(ADMIN, '/set выдумка on'));
  t('/set неизвестная настройка — список', e.sent().at(-1).includes('Доступно'));
  await e.ca.onMessage(msg(ADMIN, '/set tz Mars/Base'));
  t('/set tz: неверный пояс отклонён', e.sent().at(-1).includes('часовой пояс') && e.db.root.chatAdmin[KEY].meta.cfg.tz === undefined);
  await e.ca.onMessage(msg(ADMIN, '/setrules 1. Без спама\n2. Уважение'));
  await e.ca.onMessage(msg(USER, '/rules'));
  t('правила: сохранены и показываются всем', e.sent().at(-1).includes('Без спама'));
  const r2 = await e.ca.onMessage(msg(USER, '/set links on'));
  t('/set от обычного участника — отказ', e.db.root.chatAdmin[KEY].meta.cfg.links === false && e.sent().at(-1).includes('для администраторов') && r2 === true);
}

// ---------- ссылки, служебные сообщения, приветствие ----------
{
  const e = await enabled({ cfg: { links: true, cleanup: true, welcome: true, captcha: false } });
  const withLink = (from) => msg(from, 'смотри https://spam.example', { entities: [{ type: 'url', offset: 7, length: 20 }] });
  let r = await e.ca.onMessage(withLink(USER));
  t('ссылки: у обычного участника сообщение удалено, один раз предупреждение', r === true && e.calls.some((c) => c.method === 'deleteMessage') && e.sent().at(-1).includes('Ссылки'));
  const sentBefore = e.sent().length;
  await e.ca.onMessage(withLink(USER));
  t('ссылки: предупреждение не чаще раза в минуту', e.sent().length === sentBefore);
  const delsBefore = e.calls.filter((c) => c.method === 'deleteMessage').length;
  r = await e.ca.onMessage(withLink(ADMIN));
  t('ссылки: администратору можно', r === false && e.calls.filter((c) => c.method === 'deleteMessage').length === delsBefore);
  r = await e.ca.onMessage({ ...msg(USER, ''), text: undefined, new_chat_members: [{ id: 7 }] });
  t('служебное «вошёл» удаляется', r === true && e.calls.filter((c) => c.method === 'deleteMessage').length === delsBefore + 1);

  await e.ca.onChatMember(same({ invite_link: { invite_link: 'https://t.me/+AAAA', name: 'Друзья' } }));
  t('вход записан: событие, ссылка, счётчики', e.db.root.chatAdmin[KEY].daily['2026-11-11'].joins === 1 && Object.keys(e.db.root.chatAdmin[KEY].links).length === 1 && e.db.root.chatAdmin[KEY].users['7'].status === 'member');
  t('приветствие отправлено по умолчанию', e.sent().at(-1).includes('Вася') && e.sent().at(-1).includes('Наш чат'));
  await e.ca.onChatMember(same({ old_chat_member: { status: 'member', user: { id: 7 } }, new_chat_member: { status: 'left', user: { id: 7, first_name: 'Вася' } } }));
  t('выход записан', e.db.root.chatAdmin[KEY].daily['2026-11-11'].leaves === 1 && e.db.root.chatAdmin[KEY].users['7'].status === 'left');
  const selfJoin = makeEnv(); selfJoin.db.root.chatAdmin = { [KEY]: { meta: { enabled: true } } };
  await selfJoin.ca.onChatMember({ chat_member: { ...cm().chat_member, new_chat_member: { status: 'member', user: { id: Number(BOT), is_bot: true, first_name: 'Бот' } } } });
  t('собственный вход бота не записывается', selfJoin.db.writes.length === 0);
  const offJoin = makeEnv();
  await offJoin.ca.onChatMember(same({}));
  t('вход в чат, где админ-бот не включён, не записывается', offJoin.db.writes.length === 0);
}

// ---------- статистика словами ----------
{
  const e = await enabled();
  const d = (n) => dayKey(NOW - n * DAY_MS);
  e.db.root.chatAdmin[KEY].daily = { [d(0)]: { joins: 3, leaves: 1, messages: 50, how_invite: 2, how_direct: 1 }, [d(3)]: { joins: 4, leaves: 2, messages: 70, how_added: 4 }, [d(20)]: { joins: 1, how_request: 1 } };
  e.db.root.chatAdmin[KEY].links = { aaa: { name: 'Реклама', joins: 8 }, bbb: { name: 'Друзья', joins: 2 } };
  e.db.root.chatAdmin[KEY].users = { 1: { name: 'Аня', username: 'anya', messages: 90 }, 2: { name: 'Борис', messages: 150 }, 3: { name: 'Нет сообщений' } };
  e.db.root.chatAdmin[KEY].events = { [d(0)]: { x1: { t: 'join', at: NOW - 60000, name: 'Вася', username: 'vasya', how: 'invite', link: { name: 'Реклама' } }, x2: { t: 'join', at: NOW - 120000, name: 'Петя', how: 'direct' }, x3: { t: 'mod', at: NOW, action: 'ban' } } };
  await e.ca.onMessage(msg(ADMIN, '/stats'));
  const s = e.sent().at(-1);
  // (сама команда /stats — тоже сообщение администратора, поэтому +1 к 50 и 120)
t('/stats: участники, сегодня, 7 дней, способы, ссылки', s.includes('Участников: 42') && s.includes('Сегодня: +3 / −1, сообщений 51') && s.includes('За 7 дней: +7 / −3, сообщений 121') && s.includes('по пригласительной ссылке: 2') && s.includes('«Реклама» — 8'), s);
  await e.ca.onMessage(msg(ADMIN, '/top'));
  const top = e.sent().at(-1);
  t('/top: по убыванию, без тех, кто не писал', top.indexOf('Борис') < top.indexOf('Аня') && !top.includes('Нет сообщений'), top);
  await e.ca.onMessage(msg(ADMIN, '/joins'));
  const j = e.sent().at(-1);
  t('/joins: свежие входы со способом, модерация не попадает', j.includes('Вася (@vasya), по ссылке «Реклама»') && j.includes('Петя, сам') && !j.includes('ban'), j);
}

// ---------- уборка старого ----------
{
  const e = await enabled({ prunedDay: '2026-11-10' });
  e.db.root.chatAdmin[KEY].events = { '2026-01-01': { a: { t: 'join' } }, [dayKey(NOW)]: { b: { t: 'join' } } };
  e.db.root.chatAdmin[KEY].daily = { '2023-01-01': { joins: 1 }, [dayKey(NOW)]: { joins: 1 } };
  await e.ca.onMessage(msg(USER, 'привет'));
  t('уборка раз в день: старые события и дни удалены, свежие целы', !e.db.root.chatAdmin[KEY].events['2026-01-01'] && e.db.root.chatAdmin[KEY].events[dayKey(NOW)] && !e.db.root.chatAdmin[KEY].daily['2023-01-01'] && e.db.root.chatAdmin[KEY].daily[dayKey(NOW)].joins === 1 && e.db.root.chatAdmin[KEY].meta.prunedDay === '2026-11-11', e.db.root.chatAdmin[KEY]);
}

// ---------- все пути записи безопасны (то, что проверит Worker) ----------
{
  const e = await enabled();
  await e.ca.onMessage(msg(USER, 'привет'));
  await e.ca.onMessage(msg(ADMIN, '/ban x', reply(VICTIM)));
  await e.ca.onChatMember(same({ invite_link: { invite_link: 'https://t.me/+AAAA', name: '../../users/1' } }));
  const paths = e.db.writes.flatMap((u) => Object.keys(u));
  t('все пути записи — только chatAdmin/<безопасные звенья>', paths.every((p) => KEY_RE.test(p)), paths.filter((p) => !KEY_RE.test(p)));
}


// ---------- «бан везде» ----------
const GV = '4000000001';
const CHAT2 = -1009876543210, KEY2 = String(CHAT2);
async function withChats(envOpts) {
  const e = await enabled({}, envOpts);
  e.db.root.chatAdmin._global = { chats: { [KEY]: { title: 'Наш чат' }, [KEY2]: { title: 'Второй чат' } } };
  return e;
}
{
  const e = await withChats();
  let r = await e.ca.globalBan({ id: GV, name: 'Вася <b>', username: 'vasya' }, { reason: 'спам и реклама' }, { id: OWNER, name: 'Владелец' });
  const bans = e.calls.filter((c) => c.method === 'banChatMember');
  t('бан везде: заблокирован в обоих включённых чатах', bans.length === 2 && bans.every((c) => c.payload.user_id === Number(GV)) && new Set(bans.map((c) => c.payload.chat_id)).size === 2, e.calls);
  t('бан везде: игра и ВидеоЧат закрыты', e.side.gameBan[0] === GV && e.side.vcBan[0].uid === GV && e.side.vcBan[0].reason === 'спам и реклама', e.side);
  const rec = e.db.root.chatAdmin._global.bans[GV];
  t('бан везде: запись с причиной, кто поставил, итогами', rec && rec.reason === 'спам и реклама' && rec.by === OWNER && rec.game === 'banned' && rec.videochat === true && rec.chats.ok === 2 && rec.username === 'vasya', rec);
  t('бан везде: событие записано в каждый чат', [KEY, KEY2].every((k) => Object.values(e.db.root.chatAdmin[k].events || {}).some((d) => Object.values(d).some((x) => x.action === 'gban'))), e.db.root.chatAdmin);
  t('бан везде: ответ человеку — итоги', r.ok && r.text.includes('чатов 2 из 2') && r.text.includes('в игре заблокирован') && r.text.includes('ВидеоЧат закрыт'), r);
  const first = rec.at;
  const e2 = await withChats(); e2.db.root.chatAdmin._global.bans = { [GV]: { at: 111, game: 'banned', name: 'Вася' } };
  await e2.ca.globalBan({ id: GV, name: 'Вася' }, {}, { id: OWNER, name: 'В' });
  t('повторный бан: дата первого сохраняется, повторно блокирует чаты', e2.db.root.chatAdmin._global.bans[GV].at === 111 && e2.calls.filter((c) => c.method === 'banChatMember').length === 2 && first === NOW);

  r = await e.ca.globalBan({ id: OWNER, name: 'Я' }, {}, { id: OWNER, name: 'Я' });
  t('бан везде: владельца и бота нельзя', r.ok === false && (await e.ca.globalBan({ id: BOT, name: 'бот' })).ok === false);
  const eRole = await withChats({ roles: { [GV]: 'admin' } });
  r = await eRole.ca.globalBan({ id: GV, name: 'Админ' }, {}, { id: OWNER, name: 'В' });
  t('бан везде: админа проекта нельзя (сначала снять роль)', r.ok === false && r.text.includes('админ') && !eRole.calls.some((c) => c.method === 'banChatMember'));
  r = await e.ca.globalBan({ id: '12', name: 'Короткий' });
  t('бан везде: id короче 5 цифр отклоняется', r.ok === false);
  const eFail = await withChats({ tgOverrides: { banChatMember: (p) => (p.chat_id === CHAT2 ? { ok: false, description: 'Bad Request: not enough rights to restrict/unrestrict chat member' } : { ok: true, result: true }) } });
  r = await eFail.ca.globalBan({ id: GV, name: 'Вася' }, {}, { id: OWNER, name: 'В' });
  t('бан везде: в одном чате нет прав — остальное выполнено, причина названа', r.ok && r.chats.filter((c) => c.ok).length === 1 && r.text.includes('В 1 чат') && r.text.includes('нет нужного права') && eFail.db.root.chatAdmin._global.bans[GV].chats.fail === 1, r);
  const eNone = await enabled({}, { }); eNone.db.root.chatAdmin._global = undefined; delete eNone.db.root.chatAdmin._global;
  r = await eNone.ca.globalBan({ id: GV, name: 'Вася' }, {}, { id: OWNER, name: 'В' });
  t('бан везде: включённых чатов нет — действует в игре и ВидеоЧате, текст честный', r.ok && r.text.includes('Включённых чатов пока нет') && eNone.side.vcBan.length === 1);

  // разбан
  r = await e.ca.globalUnban({ id: GV }, { id: OWNER, name: 'Владелец' });
  t('разбан везде: чаты, игра (она была заблокирована нами) и ВидеоЧат', r.ok && e.calls.filter((c) => c.method === 'unbanChatMember').length === 2 && e.side.gameUnban[0] === GV && e.side.vcUnban[0] === GV && !(e.db.root.chatAdmin._global.bans || {})[GV], { r, side: e.side });
  const eAlready = await withChats({ gameState: 'already' });
  await eAlready.ca.globalBan({ id: GV, name: 'Вася' }, {}, { id: OWNER, name: 'В' });
  await eAlready.ca.globalUnban({ id: GV }, { id: OWNER, name: 'В' });
  t('разбан везде: если в игре его забанили раньше и не мы — игру не трогаем', eAlready.side.gameUnban.length === 0 && eAlready.side.vcUnban.length === 1);
  r = await e.ca.globalUnban({ id: '555555555' }, {});
  t('разбан везде: кого нет в списке — понятный ответ', r.ok === false && r.text.includes('нет в списке'));
}

// ---------- не впускаем ----------
{
  const e = await withChats();
  e.db.root.chatAdmin._global.bans = { [GV]: { at: 1, name: 'Вася', game: 'banned' } };
  e.db.root.chatAdmin[KEY].meta.cfg = { welcome: true };
  await e.ca.onChatMember(same({ new_chat_member: { status: 'member', user: { id: Number(GV), first_name: 'Вася' } }, old_chat_member: { status: 'left', user: { id: Number(GV) } } }).chat_member ? { chat_member: { ...cm().chat_member, from: { id: Number(GV), first_name: 'Вася' }, new_chat_member: { status: 'member', user: { id: Number(GV), first_name: 'Вася' } }, old_chat_member: { status: 'left', user: { id: Number(GV) } } } } : null);
  t('вход человека из «бана везде»: блокируется сразу', e.calls.some((c) => c.method === 'banChatMember' && c.payload.user_id === Number(GV)));
  t('…приветствия нет, обычного входа в статистике нет', e.sent().length === 0 && !(e.db.root.chatAdmin[KEY].daily && e.db.root.chatAdmin[KEY].daily['2026-11-11'] && e.db.root.chatAdmin[KEY].daily['2026-11-11'].joins), e.db.root.chatAdmin[KEY]);
  const ev = Object.values(Object.values(e.db.root.chatAdmin[KEY].events)[0]).find((x) => x.action === 'gban_block');
  t('…в журнале чата — «не впустили»', !!ev && ev.target.id === GV, e.db.root.chatAdmin[KEY].events);
  const e2 = await withChats();
  e2.db.root.chatAdmin._global.bans = { [GV]: { at: 1, name: 'Вася' } };
  const r2 = await e2.ca.onMessage({ ...msg(OWNER, ''), text: undefined, new_chat_members: [{ id: Number(GV), first_name: 'Вася' }] });
  t('служебное «вошёл» человека из списка: блокировка и удаление сообщения', r2 === true && e2.calls.some((c) => c.method === 'banChatMember') && e2.calls.some((c) => c.method === 'deleteMessage'));
  const r3 = await e2.ca.onMessage(msg(GV, 'я вернулся'));
  t('сообщение человека из списка: блокировка, сообщение удалено, не считается', r3 === true && e2.calls.filter((c) => c.method === 'deleteMessage').length === 2 && !e2.db.root.chatAdmin[KEY].users);
  const e3 = await withChats();
  await e3.ca.onChatMember({ chat_member: { ...cm().chat_member, new_chat_member: { status: 'member', user: { id: 4000000002, first_name: 'Другой' } }, old_chat_member: { status: 'left', user: { id: 4000000002 } } } });
  t('обычный человек входит как обычно', !e3.calls.some((c) => c.method === 'banChatMember') && e3.db.root.chatAdmin[KEY].daily['2026-11-11'].joins === 1);
}

// ---------- команды /gban и /ungban ----------
{
  const e = await withChats();
  await e.ca.onMessage(msg(ADMIN, '/gban спам', reply(GV)));
  t('/gban от обычного админа чата — отказ, ничего не выполнено', e.sent().at(-1).includes('только для владельца') && e.side.vcBan.length === 0 && !e.calls.some((c) => c.method === 'banChatMember'));
  await e.ca.onMessage(msg(OWNER, '/gban реклама казино', reply(GV)));
  t('/gban от владельца ответом: бан везде с причиной', e.side.vcBan[0].reason === 'реклама казино' && e.sent().at(-1).includes('заблокирован везде'), e.sent());
  await e.ca.onMessage(msg(OWNER, '/ungban', reply(GV)));
  t('/ungban от владельца: снят', e.sent().at(-1).includes('бан везде снят') && e.side.vcUnban.length === 1);
  await e.ca.onMessage(msg(OWNER, '/gban 777777777 по id'));
  t('/gban по числовому id', e.side.vcBan.some((b) => b.uid === '777777777'));
  await e.ca.onMessage(msg(OWNER, '/gban'));
  t('/gban без цели — подсказка', e.sent().at(-1).includes('Ответьте этой командой'));
}

// ---------- индекс включённых чатов ----------
{
  const e = makeEnv({ statuses: { [BOT]: 'administrator' } });
  await e.ca.onMessage(msg(OWNER, '/admin_on'));
  t('включение: чат попал в список включённых (для «бана везде»)', e.db.root.chatAdmin._global.chats[KEY].title === 'Наш чат', e.db.root.chatAdmin);
  await e.ca.onMessage(msg(OWNER, '/admin_off'));
  t('выключение: чат убран из списка', e.db.root.chatAdmin._global.chats[KEY] === undefined);
}


// ---------- проверка «я не бот» ----------
const join = (id, name, over = {}) => ({ chat_member: { ...cm().chat_member, from: { id: Number(id), first_name: name }, old_chat_member: { status: 'left', user: { id: Number(id) } }, new_chat_member: { status: 'member', user: { id: Number(id), first_name: name } }, ...over } });
const press = (from, data, msgId = 905) => ({ id: 'q1', from: { id: Number(from), first_name: 'Вася' }, data, message: { message_id: msgId, chat: { id: CHAT, type: 'supergroup', title: 'Наш чат' } } });
const cap = (e) => e.db.root.chatAdmin[KEY].pending || {};
const enabledCap = (extra = {}, opts) => enabled({ ...extra, cfg: { captcha: true, ...(extra.cfg || {}) } }, opts);

// ---------- чужие владельцы: создатель чата включает бота сам ----------
{
  const STRANGER = '900', STRANGER2 = '901';
  const e = makeEnv({ statuses: { [STRANGER]: 'creator', [STRANGER2]: 'administrator' } });
  let r = await e.ca.onMessage(msg(USER, '/admin_on'));
  t('чужой чат: обычный участник включить не может — тишина', r === true && e.sent().length === 0 && e.db.writes.length === 0);
  r = await e.ca.onMessage(msg(STRANGER2, '/admin_on'));
  t('чужой чат: администратор (не создатель) — короткий отказ, ничего не пишем', r === true && e.sent().at(-1).includes('создатель') && e.db.writes.length === 0);
  r = await e.ca.onMessage(msg(STRANGER, '/admin_on'));
  const c = e.db.root.chatAdmin;
  t('чужой чат: создатель включил — владелец записан', r === true && c[KEY].meta.enabled === true && c[KEY].meta.enabledBy === STRANGER && c._owners[STRANGER][KEY].title === 'Наш чат');
  t('чужой чат: в список «бана везде» не попал, лежит отдельно', !(c._global && c._global.chats && c._global.chats[KEY]) && c._global.tenants[KEY]);
  t('чужой чат: подсказка про панель', e.sent().at(-1).includes('/admin'));
  // «бан везде» чужой чат не сторожит
  c._global.bans = { 4000000001: { at: 1 } };
  await e.ca.onChatMember(join(4000000001, 'Вася'));
  t('чужой чат: «бан везде» владельца проекта здесь не действует', !e.calls.some((x) => x.method === 'banChatMember'));
  // лимит чатов у одного человека
  const lim = makeEnv({ statuses: { [STRANGER]: 'creator' } });
  lim.db.root.chatAdmin = { _owners: { [STRANGER]: Object.fromEntries(Array.from({ length: 10 }, (_, i) => ['-100' + (5000 + i), { title: 'x' }])) } };
  r = await lim.ca.onMessage(msg(STRANGER, '/admin_on'));
  t('чужой чат: больше 10 чатов на человека не подключить', r === true && lim.sent().at(-1).includes('не больше 10') && !(lim.db.root.chatAdmin[KEY]));
  r = await e.ca.onMessage(msg(STRANGER, '/admin_off'));
  t('чужой чат: создатель может выключить', e.db.root.chatAdmin[KEY].meta.enabled === false && !(e.db.root.chatAdmin._global.tenants && e.db.root.chatAdmin._global.tenants[KEY]));
}

t('капча: по умолчанию ВКЛЮЧЕНА (настройка не задана)', (await (async () => { const e = await enabled({}); await e.ca.onChatMember(join(7, 'Вася')); return e.calls.some((c) => c.method === 'restrictChatMember') && e.calls.some((c) => c.method === 'sendMessage' && c.payload.reply_markup); })()));
{
  const e = await enabledCap({ cfg: { welcome: true } });
  await e.ca.onChatMember(join(7, 'Вася <b>x</b>'));
  const restr = e.calls.filter((c) => c.method === 'restrictChatMember');
  t('капча: новичок сразу ограничен', restr.length === 1 && restr[0].payload.user_id === 7 && restr[0].payload.permissions.can_send_messages === false, restr);
  const msgCall = e.calls.find((c) => c.method === 'sendMessage');
  t('капча: сообщение с кнопкой «Я не бот» и упоминанием', !!msgCall && msgCall.payload.reply_markup.inline_keyboard[0][0].callback_data === 'cap:7' && msgCall.payload.text.includes('tg://user?id=7') && msgCall.payload.parse_mode === 'HTML', msgCall);
  t('капча: чужая разметка в имени экранируется', msgCall.payload.text.includes('Вася &lt;b&gt;x&lt;/b&gt;') && !msgCall.payload.text.includes('<b>x</b>'), msgCall.payload.text);
  t('капча: приветствия пока нет (оно после проверки)', e.sent().length === 1 && !e.sent()[0].includes('Привет'), e.sent());
  const p = cap(e)['7'];
  t('капча: запись «ждём» — срок 10 секунд, номер сообщения', p && p.until === NOW + 10000 && p.msgId === msgCall.payload ? true : (p && p.until === NOW + 10000 && typeof p.msgId === 'number'), p);
  t('капча: вход всё равно записан в статистику', e.db.root.chatAdmin[KEY].daily['2026-11-11'].joins === 1);
  // чужое нажатие
  const before = e.calls.length;
  await e.ca.onCallback(press(8, 'cap:7'));
  const ans = e.calls.slice(before).find((c) => c.method === 'answerCallbackQuery');
  t('капча: чужая кнопка — отказ, проверка не снята', ans.payload.text.includes('не ваша') && !!cap(e)['7'] && !e.calls.slice(before).some((c) => c.method === 'restrictChatMember'), ans);
  // своё нажатие
  const r = await e.ca.onCallback(press(7, 'cap:7', p.msgId));
  const lift = e.calls.filter((c) => c.method === 'restrictChatMember').at(-1);
  t('капча: своё нажатие возвращает права чата', r === true && lift.payload.permissions.can_send_messages === true && lift.payload.permissions.can_send_photos === true && lift.payload.permissions.can_change_info === false, lift);
  t('капча: сообщение с кнопкой удалено, запись «ждём» снята', e.calls.some((c) => c.method === 'deleteMessage' && c.payload.message_id === p.msgId) && !cap(e)['7']);
  t('капча: пройдено — отметка, счётчик, событие', e.db.root.chatAdmin[KEY].users['7'].verifiedAt === NOW && e.db.root.chatAdmin[KEY].daily['2026-11-11'].captcha_ok === 1 && Object.values(Object.values(e.db.root.chatAdmin[KEY].events)[0]).some((x) => x.action === 'captcha_pass'));
  t('капча: приветствие — после проверки', e.sent().at(-1).includes('Привет') && e.sent().at(-1).includes('Вася'), e.sent());
  const before2 = e.calls.length;
  await e.ca.onCallback(press(7, 'cap:7'));
  const ans2 = e.calls.slice(before2).find((c) => c.method === 'answerCallbackQuery');
  t('капча: повторное нажатие — «время вышло», ничего не меняется', ans2.payload.text.includes('вышло') && ans2.payload.show_alert === true);
  t('капча: не наша кнопка — не обрабатывается', (await e.ca.onCallback(press(7, 'login:approve:1'))) === false);
  t('капча: все пути записи — безопасные', e.db.writes.every((w) => Object.keys(w).every((k) => KEY_RE.test(k))), e.db.writes.flatMap((w) => Object.keys(w)).filter((k) => !KEY_RE.test(k)));
}
{
  // не нажал вовремя: выгоняем, в статистике «бана» нет
  const e = await enabledCap({});
  await e.ca.onChatMember(join(7, 'Вася'));
  const p = cap(e)['7'];
  e.clock.t = NOW + 5000;
  t('таймер: рано — никого не выгоняем', (await e.ca.sweepCaptcha(KEY, true)) === 0 && !e.calls.some((c) => c.method === 'banChatMember'));
  e.clock.t = NOW + 11000;
  t('таймер: срок вышел — выгнан', (await e.ca.sweepCaptcha(KEY, true)) === 1);
  const bans = e.calls.filter((c) => c.method === 'banChatMember');
  const unb = e.calls.filter((c) => c.method === 'unbanChatMember');
  t('таймер: бан и сразу разбан (может зайти снова)', bans.length === 1 && bans[0].payload.user_id === 7 && unb.length === 1 && unb[0].payload.only_if_banned === true, { bans, unb });
  t('таймер: сообщение с кнопкой удалено', e.calls.some((c) => c.method === 'deleteMessage' && c.payload.message_id === p.msgId));
  t('таймер: счётчик и событие «не прошёл»', e.db.root.chatAdmin[KEY].daily['2026-11-11'].captcha_fail === 1 && e.db.root.chatAdmin[KEY].users['7'].status === 'left' && Object.values(Object.values(e.db.root.chatAdmin[KEY].events)[0]).some((x) => x.action === 'captcha_fail'));
  t('таймер: второй проход тех же не трогает', (await e.ca.sweepCaptcha(KEY, true)) === 0);
  // события бана/разбана от этого выгоняния не попадают в статистику
  const joinsBefore = e.db.root.chatAdmin[KEY].daily['2026-11-11'];
  await e.ca.onChatMember(join(7, 'Вася', { from: { id: Number(BOT), first_name: 'Бот' }, old_chat_member: { status: 'restricted', is_member: true, user: { id: 7 } }, new_chat_member: { status: 'kicked', user: { id: 7, first_name: 'Вася' } } }));
  t('таймер: «бан» от самого бота в статистику не идёт', !e.db.root.chatAdmin[KEY].daily['2026-11-11'].bans, e.db.root.chatAdmin[KEY].daily);
  await e.ca.onChatMember(join(7, 'Вася', { from: { id: Number(BOT), first_name: 'Бот' }, old_chat_member: { status: 'kicked', user: { id: 7 } }, new_chat_member: { status: 'left', user: { id: 7, first_name: 'Вася' } } }));
  t('таймер: после «разбана» запись «ждём» убрана', !cap(e)['7']);
}
{
  // кого проверка не касается
  const addedByAdmin = await enabledCap({ cfg: { welcome: true } });
  await addedByAdmin.ca.onChatMember(join(7, 'Вася', { from: { id: Number(ADMIN), first_name: 'Админ' } }));
  t('капча: добавил администратор — без проверки, приветствие сразу', !addedByAdmin.calls.some((c) => c.method === 'restrictChatMember') && addedByAdmin.sent().at(-1).includes('Привет'), addedByAdmin.calls.map((c) => c.method));
  const addedByUser = await enabledCap({});
  await addedByUser.ca.onChatMember(join(7, 'Вася', { from: { id: Number(USER), first_name: 'Обычный' } }));
  t('капча: добавил обычный участник — проверка есть', addedByUser.calls.some((c) => c.method === 'restrictChatMember') && !!cap(addedByUser)['7']);
  const byRequest = await enabledCap({});
  await byRequest.ca.onChatMember(join(7, 'Вася', { via_join_request: true }));
  t('капча: по заявке (одобрил админ) — без проверки', !byRequest.calls.some((c) => c.method === 'restrictChatMember'));
  const owner = await enabledCap({});
  await owner.ca.onChatMember(join(OWNER, 'Владелец'));
  t('капча: владельцу проект проверка не нужна', !owner.calls.some((c) => c.method === 'restrictChatMember'));
  const known = await enabledCap({});
  known.db.root.chatAdmin[KEY].users = { 7: { verifiedAt: 5 } };
  await known.ca.onChatMember(join(7, 'Вася'));
  t('капча: уже проходил проверку — не мучаем снова', !known.calls.some((c) => c.method === 'restrictChatMember'));
  const old = await enabledCap({});
  await old.ca.onMessage(msg(7, 'привет, я давно тут'));
  await old.ca.onChatMember({ chat_member: { ...cm().chat_member, from: { id: 7, first_name: 'Вася' }, old_chat_member: { status: 'member', user: { id: 7 } }, new_chat_member: { status: 'member', user: { id: 7, first_name: 'Вася' } } } });
  t('капча: кто уже в группе — не трогаем (ни сообщение, ни смена статуса)', !old.calls.some((c) => c.method === 'restrictChatMember') && !cap(old)['7']);
  const off = await enabledCap({ cfg: { captcha: false, welcome: true } });
  await off.ca.onChatMember(join(7, 'Вася'));
  t('капча: выключена — как раньше (приветствие сразу)', !off.calls.some((c) => c.method === 'restrictChatMember') && off.sent().at(-1).includes('Привет'));
  const noRights = await enabledCap({ cfg: { welcome: true } }, { tgOverrides: { restrictChatMember: () => ({ ok: false, description: 'Bad Request: not enough rights to restrict/unrestrict chat member' }) } });
  await noRights.ca.onChatMember(join(7, 'Вася'));
  t('капча: нет права ограничивать — впускаем как раньше, записи «ждём» нет', !cap(noRights)['7'] && noRights.sent().at(-1).includes('Привет') && !noRights.calls.some((c) => c.method === 'sendMessage' && c.payload.reply_markup));
  let sendFails = 0;
  const noSend = await enabledCap({}, { tgOverrides: { sendMessage: () => { sendFails++; return { ok: false, description: 'Bad Request: chat not found' }; } } });
  await noSend.ca.onChatMember(join(7, 'Вася'));
  t('капча: кнопку отправить не вышло — права возвращены, человек не остаётся немым', noSend.calls.filter((c) => c.method === 'restrictChatMember').length === 2 && noSend.calls.filter((c) => c.method === 'restrictChatMember')[1].payload.permissions.can_send_messages === true && !cap(noSend)['7']);
}
{
  // ушёл сам во время проверки
  const e = await enabledCap({});
  await e.ca.onChatMember(join(7, 'Вася'));
  const p = cap(e)['7'];
  await e.ca.onChatMember(join(7, 'Вася', { from: { id: 7, first_name: 'Вася' }, old_chat_member: { status: 'restricted', is_member: true, user: { id: 7 } }, new_chat_member: { status: 'left', user: { id: 7, first_name: 'Вася' } } }));
  t('капча: ушёл сам — кнопка убрана, запись «ждём» снята, выход записан', e.calls.some((c) => c.method === 'deleteMessage' && c.payload.message_id === p.msgId) && !cap(e)['7'] && e.db.root.chatAdmin[KEY].daily['2026-11-11'].leaves === 1);
}
{
  // не получилось выгнать: возвращаем права, чтобы не оставить человека немым
  const e = await enabledCap({}, { tgOverrides: { banChatMember: () => ({ ok: false, description: 'Bad Request: not enough rights to restrict/unrestrict chat member' }) } });
  await e.ca.onChatMember(join(7, 'Вася'));
  e.clock.t = NOW + 200000;
  await e.ca.sweepCaptcha(KEY, true);
  const restr = e.calls.filter((c) => c.method === 'restrictChatMember');
  t('таймер: выгнать не вышло — права возвращены, запись снята, «не прошёл» не пишем', restr.length === 2 && restr[1].payload.permissions.can_send_messages === true && !cap(e)['7'] && !e.db.root.chatAdmin[KEY].daily['2026-11-11'].captcha_fail, restr);
}
{
  // много сразу + обход всех чатов (cron)
  const e = await withChats();
  e.db.root.chatAdmin[KEY].meta.cfg = { captcha: true };
  e.db.root.chatAdmin[KEY].pending = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(500 + i), { at: NOW, until: NOW + 1, msgId: 10 + i, name: 'N' + i }]));
  e.clock.t = NOW + 5000;
  const n = await e.ca.sweepAll();
  t('cron: за один проход не больше 8 человек (лимит подзапросов)', n === 8 && e.calls.filter((c) => c.method === 'banChatMember').length === 8, n);
  const n2 = await e.ca.sweepAll();
  t('cron: остальных — в следующий проход', n2 === 4);
  const off = await withChats();
  off.db.root.chatAdmin[KEY].meta.cfg = { captcha: false };
  off.db.root.chatAdmin[KEY].pending = { 500: { at: NOW, until: NOW + 1, msgId: 1, name: 'N' } };
  off.clock.t = NOW + 5000;
  t('cron: чат с выключенной проверкой не трогаем', (await off.ca.sweepAll()) === 0);
  const junk = await enabledCap({});
  junk.db.root.chatAdmin[KEY].pending = { abc: { until: 1 }, 600: 'мусор', 601: null };
  junk.clock.t = NOW + 5000;
  t('таймер: мусор в базе не ломает проход', (await junk.ca.sweepCaptcha(KEY, true)) === 0);
}
{
  // настройки
  const e = await enabledCap({});
  await e.ca.onMessage(msg(ADMIN, '/set captcha off'));
  t('/set captcha off', e.db.root.chatAdmin[KEY].meta.cfg.captcha === false);
  await e.ca.onMessage(msg(ADMIN, '/set captchaSec 30'));
  t('/set captchaSec 30', e.db.root.chatAdmin[KEY].meta.cfg.captchaSec === 30);
  await e.ca.onMessage(msg(ADMIN, '/set captchaSec 5'));
  t('/set captchaSec 5 — можно (меньше 10 тоже)', e.db.root.chatAdmin[KEY].meta.cfg.captchaSec === 5);
  await e.ca.onMessage(msg(ADMIN, '/set captchaSec 30'));
  await e.ca.onMessage(msg(ADMIN, '/set captchaSec 2'));
  t('/set captchaSec 50 — отказ', e.db.root.chatAdmin[KEY].meta.cfg.captchaSec === 30 && e.sent().at(-1).includes('от 3 до 600'));
  await e.ca.onMessage(msg(ADMIN, '/set callChannel мусор'));
  t('/set callChannel: плохой адрес — отказ', !e.db.root.chatAdmin[KEY].meta.cfg.callChannel && e.sent().at(-1).includes('Нужен номер канала'));
  await e.ca.onMessage(msg(ADMIN, '/set callChannel -1009876543210'));
  t('/set callChannel: бот админ канала — сохраняется', e.db.root.chatAdmin[KEY].meta.cfg.callChannel === '-1009876543210');
  const nb = await enabledCap({}, { tgOverrides: { getChatMember: (pl) => (String(pl.chat_id) === '-1009876543210' ? { ok: true, result: { status: 'member' } } : { ok: true, result: { status: Number(pl.user_id) === Number(ADMIN) ? 'administrator' : 'administrator' } }) } });
  await nb.ca.onMessage(msg(ADMIN, '/set callChannel -1009876543210'));
  t('/set callChannel: бот не админ канала — отказ без записи', !nb.db.root.chatAdmin[KEY].meta.cfg.callChannel && nb.sent().at(-1).includes('не администратор'));
  await e.ca.onMessage(msg(ADMIN, '/set callChannel off'));
  t('/set callChannel off — принимается', e.db.root.chatAdmin[KEY].meta.cfg.callChannel === '');
  await e.ca.onMessage(msg(ADMIN, '/settings'));
  t('/settings показывает проверку «я не бот»', e.sent().at(-1).includes('captcha') && e.sent().at(-1).includes('captchaSec'));
}

// ---------- пауза, возобновление и перезагрузка ----------
{
  const e = await enabled({}, {});
  let hook = 0; e.deps.onEnabled = async () => { hook++; }; e.deps.pace = false;
  let r = await e.ca.onMessage(msg(USER, '/pause 30'));
  t('/pause: обычному участнику отказ, паузы нет', e.sent().at(-1).includes('для администраторов') && !(e.db.root.chatAdmin[KEY].meta.pausedUntil));
  r = await e.ca.onMessage(msg(ADMIN, '/pause 30'));
  t('/pause 30: пауза на 30 минут записана', e.db.root.chatAdmin[KEY].meta.pausedUntil === NOW + 30 * 60000 && e.sent().at(-1).includes('30 мин.'), e.db.root.chatAdmin[KEY].meta);
  const before = e.db.writes.length;
  r = await e.ca.onMessage(msg(USER, 'привет всем'));
  t('на паузе: обычное сообщение не считается и не обрабатывается', r === false && e.db.writes.length === before);
  r = await e.ca.onMessage(msg(ADMIN, '/ban 12345678'));
  t('на паузе: команды модерации не работают', r === false && !e.calls.some((c) => c.method === 'banChatMember'));
  e.clock.t = NOW + 31 * 60000;
  r = await e.ca.onMessage(msg(USER, 'уже можно'));
  t('пауза кончилась сама: бот снова считает сообщения', e.db.writes.length > before);
  await e.ca.onMessage(msg(ADMIN, '/pause 2h'));
  e.clock.t = NOW + 32 * 60000;
  const n = e.sent().length;
  await e.ca.onMessage(msg(ADMIN, '/resume'));
  t('/resume: пауза снята сразу', !e.db.root.chatAdmin[KEY].meta.pausedUntil && e.sent().at(-1).includes('Пауза снята') && e.sent().length === n + 1, [e.db.root.chatAdmin[KEY].meta.pausedUntil, e.sent().slice(-2), n]);
  await e.ca.onMessage(msg(ADMIN, '/pause абв'));
  t('/pause с мусором — подсказка про срок', e.sent().at(-1).includes('Укажите срок'));
  await e.ca.onMessage(msg(ADMIN, '/pause 999d'));
  t('/pause: больше недели не бывает', e.db.root.chatAdmin[KEY].meta.pausedUntil === e.clock.t + 7 * 86400000);
  await e.ca.onMessage(msg(ADMIN, '/reload'));
  const edits = e.calls.filter((c) => c.method === 'editMessageText').map((c) => c.payload.text);
  t('/reload: одно сообщение редактируется по шагам (анимация), в конце итог', e.sent().at(-1).includes('Перезагрузка бота') && edits.length >= 5 && edits.some((x) => x.includes('[█████')) && edits.at(-1).includes('Перезагружено'), edits);
  t('/reload во время паузы работает, вебхук перепроверен, права бота прочитаны', hook === 1 && edits.at(-1).includes('на паузе') && e.db.root.chatAdmin[KEY].meta.botStatus === 'administrator');
  await e.ca.onMessage(msg(ADMIN, '/resume'));
  await e.ca.onMessage(msg(USER, '/reload'));
  t('/reload обычному участнику — отказ', e.sent().at(-1).includes('для администраторов'));
}
{
  // пауза отпускает тех, кто проходил проверку «я не бот»
  const e = await enabled({}, {});
  e.db.root.chatAdmin[KEY].pending = { 777: { at: NOW, until: NOW + 10000, msgId: 55, name: 'Н' } };
  await e.ca.onMessage(msg(ADMIN, '/pause 10'));
  t('пауза: ожидавший проверку получил права назад, кнопка удалена, запись снята',
    e.calls.some((c) => c.method === 'restrictChatMember' && c.payload.user_id === 777 && c.payload.permissions.can_send_messages === true)
    && e.calls.some((c) => c.method === 'deleteMessage' && c.payload.message_id === 55) && !(e.db.root.chatAdmin[KEY].pending && e.db.root.chatAdmin[KEY].pending[777]));
}

// ---------- служебные сообщения стирают себя через 3 секунды ----------
{
  const e = await enabled({}, {});
  const pend = []; const sleeps = []; let release; let gate = new Promise((r) => { release = r; });
  const open = () => { release(); gate = new Promise((r) => { release = r; }); };
  e.deps.later = (p) => pend.push(p); e.deps.sleep = (ms) => { sleeps.push(ms); return gate; }; e.deps.pace = false;
  const dels = () => e.calls.filter((c) => c.method === 'deleteMessage').map((c) => c.payload.message_id);
  await e.ca.onMessage(msg(ADMIN, '/pause 30'));
  const botId = e.calls.filter((c) => c.method === 'sendMessage').at(-1);
  t('служебное сообщение: до срока не удалено', dels().length === 0);
  open(); await Promise.all(pend.splice(0));
  t('служебное сообщение стёрто через 3 секунды вместе с командой админа', sleeps.at(-1) === 3000 && dels().length === 2 && dels().includes(1), dels());
  e.calls.length = 0;
  await e.ca.onMessage(msg(USER, '/pause'));
  open(); await Promise.all(pend.splice(0));
  t('отказ («для администраторов») тоже стирается', e.calls.some((c) => c.method === 'deleteMessage'));
  e.calls.length = 0;
  await e.ca.onMessage(msg(ADMIN, '/resume'));
  await e.ca.onMessage(msg(ADMIN, '/help'));
  open(); await Promise.all(pend.splice(0));
  const helpMsgs = e.calls.filter((c) => c.method === 'sendMessage' && c.payload.text.includes('Команды администратора'));
  t('/help не стирается, а подтверждение /resume — да', helpMsgs.length === 1 && dels().length === 2, dels());
  e.calls.length = 0;
  await e.ca.onMessage(msg(ADMIN, '/reload'));
  const lastEdit = e.calls.map((c) => c.method).lastIndexOf('editMessageText');
  t('/reload: до конца загрузки ничего не удаляется', !e.calls.some((c) => c.method === 'deleteMessage'));
  open(); await Promise.all(pend.splice(0));
  const firstDel = e.calls.map((c) => c.method).indexOf('deleteMessage');
  t('/reload: сообщение с загрузкой стирается через 3 секунды после итога', firstDel > lastEdit && dels().length === 2, [firstDel, lastEdit, dels()]);
}
{
  // без фонового исполнителя (deps.later) сообщения остаются, ничего не ломается
  const e = await enabled({}, {});
  await e.ca.onMessage(msg(ADMIN, '/pause 5'));
  t('без deps.later сообщение просто остаётся', !e.calls.some((c) => c.method === 'deleteMessage'));
}

// ---------- «позвать всех» ----------
{
  const e = await enabled({}, {});
  const users = {};
  for (let i = 0; i < 70; i++) users[String(5000000 + i)] = { name: 'Ч' + i, username: i % 2 === 0 ? 'user_' + i + 'abc' : undefined, messages: 1, lastSeen: NOW - i * 1000 };
  users['9000001'] = { name: 'Ушёл', status: 'left', lastSeen: NOW, username: 'gone_user' };
  users['9000002'] = { name: 'Забанен', status: 'banned', lastSeen: NOW, username: 'banned_user' };
  e.db.root.chatAdmin[KEY].users = users;
  e.deps.videoRoom = async () => 'https://t.me/x/y?startapp=' + KEY;
  const orig = e.deps.tg;
  e.deps.tg = async (m, p) => (m === 'getChatAdministrators' ? (e.calls.push({ method: m, payload: p }), { ok: true, result: [{ user: { id: 200, username: 'adminboss' } }, { user: { id: 7000000001, is_bot: true } }, { user: { id: 5000001 } }, { user: { id: 6000000, first_name: 'Новый', username: 'new_admin' } }] }) : orig(m, p));
  await e.ca.onMessage(msg(USER, '/all'));
  t('/all: обычному участнику отказ, ничего не отправлено', !e.calls.some((c) => c.method === 'sendMessage' && c.payload.text.includes('@user_')));
  await e.ca.onMessage(msg(ADMIN, '/all Идём в видеочат'));
  const sends = e.calls.filter((c) => c.method === 'sendMessage' && /@user_|Ч\d/.test(c.payload.text));
  t('/all: 70 известных + админ из списка Telegram = 71 человек, сообщения по 30/30/11', sends.length === 3 && sends[0].payload.text.split(', ').length === 30 && sends[2].payload.text.split(', ').length === 11, sends.map((c) => c.payload.text.split(', ').length));
  t('/all: у кого есть @имя — пишется «@имя» (Telegram сам уведомляет), заголовок в первом сообщении', sends[0].payload.text.startsWith('Идём в видеочат\n@user_0abc, ') && !sends[1].payload.text.startsWith('Идём'));
  const withEnt = sends.flatMap((c) => c.payload.entities || []);
  const full = sends.map((c) => c.payload.text).join('\n');
  t('/all: у кого @имени нет — видимое имя и привязка text_mention по смещению', withEnt.length === 35 && withEnt.every((en) => en.type === 'text_mention') && (() => { const c = sends[0]; const en = c.payload.entities[0]; return c.payload.text.slice(en.offset, en.offset + en.length) === 'Ч1' && en.user.id === 5000001; })(), withEnt.length);
  t('/all: нет ушедших, забаненных, бота и отправителя; админ добавлен; повторов нет', !full.includes('gone_user') && !full.includes('banned_user') && !full.includes('adminboss') && full.includes('@new_admin') && !full.includes('7000000001'));
  t('/all: самые активные первыми', sends[0].payload.text.split('\n')[1].startsWith('@user_0abc'));
  t('/all: кнопка комнаты ВидеоЧата на первом сообщении', sends[0].payload.reply_markup.inline_keyboard[0][0].url.includes(KEY) && !sends[1].payload.reply_markup);
  const n0 = e.calls.filter((c) => c.method === 'sendMessage').length;
  await e.ca.onMessage(msg(ADMIN, '/all'));
  t('/all: чаще раза в 5 минут нельзя', e.calls.filter((c) => c.method === 'sendMessage').length === n0 + 1 && e.sent().at(-1).includes('раз в 5 минут'));
  e.clock.t += 6 * 60000;
  await e.ca.onMessage(msg(ADMIN, '/all'));
  t('/all: через 5 минут можно снова; текст по умолчанию', e.calls.filter((c) => c.method === 'sendMessage' && c.payload.text.startsWith('Зовём всех в видеочат!')).length === 1);
}
{
  // публичный чат — кнопка видеочата Telegram; пустой чат — подсказка; странные имена
  const e = await enabled({}, {});
  e.db.root.chatAdmin[KEY].users = { 5000000: { name: 'А', lastSeen: NOW, username: 'x' }, 5000001: { name: 'Б 😀', lastSeen: NOW - 1 } };
  const m = msg(ADMIN, '/all'); m.chat.username = 'my_public_chat';
  await e.ca.onMessage(m);
  const s = e.calls.find((c) => c.method === 'sendMessage' && c.payload.reply_markup);
  t('/all в публичном чате: кнопка видеочата Telegram', s.payload.reply_markup.inline_keyboard[0].some((b) => b.url === 'https://t.me/my_public_chat?videochat'));
  t('/all: слишком короткое «@имя» не считается именем, смайлик в имени не ломает смещение', s.payload.text.includes('А, ') || s.payload.text.includes('Б 😀') && s.payload.entities.every((en) => s.payload.text.slice(en.offset, en.offset + en.length).length === en.length));
  const e2 = await enabled({}, {});
  await e2.ca.onMessage(msg(ADMIN, '/all'));
  t('/all: некого звать — подсказка, кулдаун не включается', e2.sent().at(-1).includes('Пока некого звать') && !e2.db.root.chatAdmin[KEY].meta.lastAllAt);
}

// ---------- «Ирис»: карма, антифлуд, слова, ночной режим, досье, игры ----------
const cfgSet = (e, c) => { e.db.root.chatAdmin[KEY].meta.cfg = { ...(e.db.root.chatAdmin[KEY].meta.cfg || {}), ...c }; e.ca.invalidate(KEY); };
const rmsg = (from, text, to) => msg(from, text, reply(to));
{
  const e = await enabled({}, {});
  await e.ca.onMessage(rmsg(USER, 'спасибо!', VICTIM));
  t('карма: «спасибо» в ответ даёт +1, ответ бота', e.db.root.chatAdmin[KEY].karma[VICTIM].n === 1 && e.sent().at(-1).includes('Карма') && e.sent().at(-1).includes('1'), e.db.root.chatAdmin[KEY].karma);
  e.clock.t += 31000;
  await e.ca.onMessage(rmsg(USER, '+', VICTIM));
  t('карма: тому же человеку в течение часа нельзя', e.db.root.chatAdmin[KEY].karma[VICTIM].n === 1 && e.sent().at(-1).includes('меньше часа'));
  await e.ca.onMessage(rmsg(USER, '+', USER));
  t('карма: себе нельзя', !e.db.root.chatAdmin[KEY].karma[USER]);
  e.clock.t += 31000;
  await e.ca.onMessage(rmsg(ADMIN, 'минус', VICTIM));
  t('карма: «минус» отнимает', e.db.root.chatAdmin[KEY].karma[VICTIM].n === 0);
  e.clock.t += 31000;
  await e.ca.onMessage(rmsg(OWNER, 'это просто длинное сообщение без слова спасибо в начале', VICTIM));
  t('карма: обычный ответ кармы не меняет', e.db.root.chatAdmin[KEY].karma[VICTIM].n === 0);
  await e.ca.onMessage(msg(USER, '/topkarma'));
  t('/topkarma показывает людей с кармой', e.sent().at(-1).includes('Лучшая карма'), e.sent().at(-1));
  await e.ca.onMessage(rmsg(USER, '/karma', VICTIM));
  t('/karma ответом показывает карму человека', e.sent().at(-1).includes('Карма') && e.sent().at(-1).includes('0'));
  cfgSet(e, { karma: false });
  e.clock.t += 7200000;
  await e.ca.onMessage(rmsg(USER, '+', VICTIM));
  t('карма выключена настройкой', e.db.root.chatAdmin[KEY].karma[VICTIM].n === 0);
}
{
  // фильтр слов
  const e = await enabled({}, {});
  await e.ca.onMessage(msg(USER, '/addword'));
  t('/addword обычному участнику — отказ', e.sent().at(-1).includes('для администраторов'));
  await e.ca.onMessage(msg(ADMIN, '/addword казино, ставки*'));
  t('/addword: слова записаны', e.db.root.chatAdmin[KEY].meta.cfg.words === 'казино,ставки*', e.db.root.chatAdmin[KEY].meta.cfg);
  e.calls.length = 0;
  await e.ca.onMessage(msg(USER, 'Лучшее КАЗИНО тут'));
  t('фильтр: запрещённое слово — сообщение удалено, предупреждение выдано', e.calls.some((c) => c.method === 'deleteMessage') && e.db.root.chatAdmin[KEY].users[USER].warns === 1, e.db.root.chatAdmin[KEY].users[USER]);
  e.calls.length = 0;
  await e.ca.onMessage(msg(USER, 'делайте СтавкИ сегодня'));
  t('фильтр: слово со звёздочкой ловит любое окончание', e.calls.some((c) => c.method === 'deleteMessage'));
  e.calls.length = 0;
  await e.ca.onMessage(msg(USER, 'казиново — это совсем другое слово'));
  t('фильтр: без звёздочки только целое слово', !e.calls.some((c) => c.method === 'deleteMessage'));
  await e.ca.onMessage(msg(ADMIN, 'казино — админу можно'));
  t('фильтр не трогает администраторов', !e.calls.some((c) => c.method === 'deleteMessage'));
  await e.ca.onMessage(msg(ADMIN, '/delword казино'));
  t('/delword убирает слово', e.db.root.chatAdmin[KEY].meta.cfg.words === 'ставки*');
}
{
  // антифлуд, пересылки, ссылки новичков
  const e = await enabled({}, {});
  cfgSet(e, { flood: true, floodMax: 4 });
  for (let i = 0; i < 4; i++) { e.clock.t += 1000; await e.ca.onMessage(msg(USER, 'сообщение номер ' + i + ' ' + 'x'.repeat(i))); }
  t('антифлуд: до лимита ничего не происходит', !e.calls.some((c) => c.method === 'restrictChatMember'));
  e.clock.t += 1000; await e.ca.onMessage(msg(USER, 'пятое подряд'));
  const mu = e.calls.find((c) => c.method === 'restrictChatMember');
  t('антифлуд: сверх лимита — мут на 10 минут и сообщение удалено', mu && mu.payload.until_date === e.clock.t / 1000 + 600 && e.calls.some((c) => c.method === 'deleteMessage'));
  const e2 = await enabled({}, {});
  cfgSet(e2, { flood: true });
  for (let i = 0; i < 3; i++) { e2.clock.t += 5000; await e2.ca.onMessage(msg(USER, 'одно и то же сообщение')); }
  t('антифлуд: три одинаковых сообщения подряд — мут', e2.calls.some((c) => c.method === 'restrictChatMember'));
  const e3 = await enabled({}, {});
  cfgSet(e3, { flood: true, floodMax: 3 });
  for (let i = 0; i < 12; i++) { e3.clock.t += 1000; await e3.ca.onMessage(msg(ADMIN, 'админ пишет ' + i + 'я')); }
  t('антифлуд не трогает администраторов', !e3.calls.some((c) => c.method === 'restrictChatMember'));
  const e4 = await enabled({}, {});
  cfgSet(e4, { noFwd: true });
  await e4.ca.onMessage(msg(USER, 'пересланное', { forward_origin: { type: 'user' } }));
  t('пересылки: удалены, у админа можно', e4.calls.some((c) => c.method === 'deleteMessage'));
  e4.calls.length = 0;
  await e4.ca.onMessage(msg(ADMIN, 'пересланное', { forward_origin: { type: 'user' } }));
  t('пересылки: у админа не удаляются', !e4.calls.some((c) => c.method === 'deleteMessage'));
  const e5 = await enabled({}, {});
  cfgSet(e5, { newbieLinks: true });
  e5.db.root.chatAdmin[KEY].users = { [USER]: { joinedAt: NOW - 3600000 }, [VICTIM]: { joinedAt: NOW - 3 * 86400000 } };
  const link = { entities: [{ type: 'url', offset: 0, length: 10 }] };
  await e5.ca.onMessage(msg(USER, 'https://a.bc', link));
  t('ссылка от новичка (первые сутки) удалена', e5.calls.some((c) => c.method === 'deleteMessage'));
  e5.calls.length = 0;
  await e5.ca.onMessage(msg(VICTIM, 'https://a.bc', link));
  t('ссылка от старожила не удаляется', !e5.calls.some((c) => c.method === 'deleteMessage'));
}
{
  // досье
  const e = await enabled({}, {});
  e.db.root.chatAdmin[KEY].users = { 5000400: { name: 'Вася', username: 'vasya', joinedAt: NOW - 86400000, how: 'invite', messages: 12, warns: 1, lastSeen: NOW - 60000 } };
  await e.ca.onMessage(msg(USER, '/whois 5000400'));
  t('/whois обычному участнику — отказ', e.sent().at(-1).includes('для администраторов'));
  await e.ca.onMessage(msg(ADMIN, '/whois 5000400'));
  const w = e.sent().at(-1);
  t('/whois: имя, @имя, способ входа, счётчики', w.includes('Вася') && w.includes('@vasya') && w.includes('по пригласительной ссылке') && w.includes('Сообщений: 12') && w.includes('предупреждений: 1'), w);
}
{
  // ночной режим
  const e = await enabled({}, {});
  await e.ca.onMessage(msg(ADMIN, '/night 25:00-07:00'));
  t('/night: неверный формат отклонён', !e.db.root.chatAdmin[KEY].meta.cfg || !e.db.root.chatAdmin[KEY].meta.cfg.night);
  await e.ca.onMessage(msg(ADMIN, '/night 13:00-14:00'));
  t('/night: окно записано', e.db.root.chatAdmin[KEY].meta.cfg.night === '13:00-14:00');
  e.db.root.chatAdmin._global = { chats: { [KEY]: { title: 'Наш чат' } } };
  const meta = () => e.db.root.chatAdmin[KEY].meta;
  e.clock.t = Date.parse('2026-11-11T12:30:00Z'); // зимой Europe/Berlin = UTC+1 → 13:30, внутри окна
  e.calls.length = 0;
  const closed = await e.ca.sweepAll();
  t('ночной режим: в окне чат закрыт (setChatPermissions все права выключены), прежние права сохранены', e.calls.some((c) => c.method === 'setChatPermissions' && c.payload.permissions.can_send_messages === false) && meta().nightState === 'closed' && JSON.parse(meta().nightPerms).can_send_photos === true, meta());
  e.calls.length = 0;
  await e.ca.sweepAll();
  t('ночной режим: повторный проход ничего не делает', !e.calls.some((c) => c.method === 'setChatPermissions'));
  e.clock.t = Date.parse('2026-11-11T13:30:00Z'); // 14:30 — окно закончилось
  e.calls.length = 0;
  await e.ca.sweepAll();
  const open = e.calls.find((c) => c.method === 'setChatPermissions');
  t('ночной режим: после окна права возвращены такие, какими были, чат открыт', open && open.payload.permissions.can_send_messages === true && open.payload.permissions.can_send_photos === true && meta().nightState === 'open' && !meta().nightPerms, meta());
  await e.ca.onMessage(msg(ADMIN, '/night off'));
  t('/night off выключает', meta().cfg.night === '');
}
{
  // игры
  const e = await enabled({}, {});
  await e.ca.onMessage(msg(USER, '/daily'));
  t('игры выключены по умолчанию', e.sent().at(-1).includes('Игры выключены') && !e.db.root.chatAdmin[KEY].coins);
  cfgSet(e, { games: true });
  await e.ca.onMessage(msg(USER, '/daily'));
  const bal = e.db.root.chatAdmin[KEY].coins[USER].n;
  t('/daily: от 20 до 60 ирисок', bal >= 20 && bal <= 60, bal);
  await e.ca.onMessage(msg(USER, '/daily'));
  t('/daily: второй раз за день — отказ', e.sent().at(-1).includes('уже забрали') && e.db.root.chatAdmin[KEY].coins[USER].n === bal);
  await e.ca.onMessage(rmsg(USER, '/gift 10', VICTIM));
  t('/gift: перевод другому человеку', e.db.root.chatAdmin[KEY].coins[USER].n === bal - 10 && e.db.root.chatAdmin[KEY].coins[VICTIM].n === 10);
  await e.ca.onMessage(rmsg(USER, '/gift 10', USER));
  t('/gift себе нельзя', e.db.root.chatAdmin[KEY].coins[USER].n === bal - 10);
  await e.ca.onMessage(rmsg(USER, '/gift 99999', VICTIM));
  t('/gift: слишком большая сумма отклонена', e.db.root.chatAdmin[KEY].coins[VICTIM].n === 10);
  e.clock.t += 20000;
  await e.ca.onMessage(msg(USER, '/flip 5'));
  const after = e.db.root.chatAdmin[KEY].coins[USER].n;
  t('/flip: баланс изменился ровно на ставку', after === bal - 10 + 5 || after === bal - 10 - 5, after);
  await e.ca.onMessage(msg(USER, '/flip 5'));
  t('/flip: слишком быстро нельзя', e.sent().at(-1).includes('Не так быстро') && e.db.root.chatAdmin[KEY].coins[USER].n === after);
  await e.ca.onMessage(msg(USER, '/topcoins'));
  t('/topcoins показывает список', e.sent().at(-1).includes('Богатейшие'));
}
{
  const e = await enabled({}, {});
  await e.ca.onMessage(msg(ADMIN, '/set floodMax 2'));
  t('/set floodMax: меньше 3 нельзя', e.sent().at(-1).includes('от 3 до 20'));
  await e.ca.onMessage(msg(ADMIN, '/set flood on'));
  t('/set flood on', e.db.root.chatAdmin[KEY].meta.cfg.flood === true);
  await e.ca.onMessage(msg(ADMIN, '/set night 22:00-06:30'));
  t('/set night принимает время', e.db.root.chatAdmin[KEY].meta.cfg.night === '22:00-06:30');
  await e.ca.onMessage(msg(ADMIN, '/settings'));
  t('/settings показывает новые настройки', e.sent().at(-1).includes('flood') && e.sent().at(-1).includes('night'));
}

// ---------- Warn System: предупреждения администрации ----------
{
  const S1 = '201', A2 = '202', A3 = '203', NOADM = '310';
  const DAY = 86_400_000;
  const e = makeEnv({ statuses: { [S1]: 'administrator', [A2]: 'administrator', [A3]: 'administrator', [NOADM]: 'member' } });
  e.db.root.chatAdmin = { [KEY]: { meta: { enabled: true, title: 'Наш чат', enabledBy: OWNER } } };
  const dmTo = (id) => e.calls.filter((c) => c.method === 'sendMessage' && Number(c.payload.chat_id) === Number(id)).map((c) => c.payload.text);
  const noPunish = () => !e.calls.some((c) => ['restrictChatMember', 'banChatMember', 'promoteChatMember', 'setChatAdministratorCustomTitle'].includes(c.method) && Number(c.payload.user_id) === Number(A2));
  const W = () => e.db.root.chatAdmin[KEY].wn || {};
  const LOG = () => Object.values(e.db.root.chatAdmin[KEY].wnlog || {});

  await e.ca.onMessage(msg(S1, '/awarn нарушил правила', reply(A2)));
  t('Warn: администратор без статуса «старший» не может выдать', Object.keys(W()).length === 0 && e.sent().at(-1).includes('старшие администраторы'));
  await e.ca.onMessage(msg(USER, '/awarn причина', reply(A2)));
  t('Warn: обычный участник не может выдать', Object.keys(W()).length === 0);

  await e.ca.onMessage(msg(S1, '/senior add', reply(S1)));
  t('Warn: старшего назначает только руководство', !(e.db.root.chatAdmin[KEY].wnSeniors));
  await e.ca.onMessage(msg(OWNER, '/senior add', reply(S1)));
  t('Warn: руководство назначило старшего', e.db.root.chatAdmin[KEY].wnSeniors?.[S1]?.name && LOG().some((x) => x.t === 'senior_add'));

  e.clock.t = NOW;
  await e.ca.onMessage(msg(S1, '/awarn оскорбил участника', reply(A2)));
  const w1 = W().w1;
  t('Warn: выдано, записано в базу', !!w1 && w1.to === A2 && w1.by === S1 && w1.reason === 'оскорбил участника' && w1.status === 'active', W());
  t('Warn: срок ровно 20 суток в UTC', w1.until === NOW + 20 * DAY && w1.at === NOW);
  t('Warn: срок поставлен в очередь истечения', e.db.root.chatAdmin._global?.wnPending?.[KEY + '_w1'] === NOW + 20 * DAY);
  t('Warn: администратору ушло личное уведомление', dmTo(A2).length === 1 && dmTo(A2)[0].includes('№1') && dmTo(A2)[0].includes('оскорбил'));
  t('Warn: в чате публично и с упоминанием', e.calls.some((c) => c.method === 'sendMessage' && c.payload.chat_id === CHAT && (c.payload.entities || []).some((x) => x.type === 'text_mention' && x.user.id === Number(A2))));
  t('Warn: в журнале запись о выдаче', LOG().some((x) => x.t === 'issue' && x.actor === S1 && x.to === A2 && x.reason === 'оскорбил участника' && x.until === NOW + 20 * DAY));

  // запреты
  await e.ca.onMessage(msg(S1, '/awarn причина', reply(S1)));
  t('Warn: себе нельзя', Object.keys(W()).length === 1);
  await e.ca.onMessage(msg(S1, '/awarn причина', reply(OWNER)));
  t('Warn: руководству нельзя', Object.keys(W()).length === 1);
  await e.ca.onMessage(msg(S1, '/awarn причина', reply(NOADM)));
  t('Warn: только администраторам чата', Object.keys(W()).length === 1 && e.sent().at(-1).includes('не администратор'));
  await e.ca.onMessage(msg(S1, '/awarn', reply(A2)));
  t('Warn: без причины нельзя', Object.keys(W()).length === 1);

  // накопление: 2-е, потом 3-е
  e.clock.t = NOW + 2 * DAY;
  await e.ca.onMessage(msg(S1, '/awarn повторное нарушение', reply(A2)));
  t('Warn: второе — «повторное нарушение», порога нет', e.sent().some((x) => x.includes('повторное нарушение') && x.includes('Действующих: 2')) && !e.sent().some((x) => x.includes('критический порог')));
  const before = dmTo(OWNER).length;
  e.clock.t = NOW + 3 * DAY;
  await e.ca.onMessage(msg(S1, '/awarn третье нарушение', reply(A2)));
  t('Warn: третье — руководству ушло уведомление о пороге', dmTo(OWNER).length === before + 1 && dmTo(OWNER).at(-1).includes('критический порог'));
  t('Warn: старшему администратору тоже ушло уведомление', dmTo(S1).some((x) => x.includes('критический порог')));
  t('Warn: администратору — уведомление о пороге', dmTo(A2).some((x) => x.includes('критический порог')));
  t('Warn: бот никого не снимает и не ограничивает', noPunish());
  t('Warn: порог записан в журнал', LOG().some((x) => x.t === 'threshold'));

  // просмотр
  e.clock.t = NOW + 4 * DAY;
  await e.ca.onMessage(msg(S1, '/awarns', {}));
  t('Warn: /awarns — сводка по чату', e.sent().at(-1).includes('202') && e.sent().at(-1).includes('3 (критический порог)'));
  await e.ca.onMessage(msg(S1, '/awhistory', reply(A2)));
  const hist = e.sent().at(-1);
  t('Warn: /awhistory — всего, действующих, причины, даты, статус', hist.includes('Всего выдано: 3') && hist.includes('действующих: 3') && hist.includes('оскорбил участника') && hist.includes('действует до') && hist.includes('активно'));
  await e.ca.onMessage(msg(A3, '/awhistory', reply(A2)));
  t('Warn: обычный админ чужую историю не видит', e.sent().at(-1).includes('только старшие'));
  await e.ca.onMessage(msg(A2, '/awhistory', {}));
  t('Warn: свою историю админ видит', e.sent().at(-1).includes('Всего выдано: 3'));

  // отмена и удаление — только руководство
  await e.ca.onMessage(msg(S1, '/awcancel 2 ошибочно', {}));
  t('Warn: старший не может отменить', W().w2.status === 'active' && e.sent().at(-1).includes('только руководство'));
  await e.ca.onMessage(msg(OWNER, '/awcancel 2', {}));
  t('Warn: отмена без причины не принимается', W().w2.status === 'active');
  e.clock.t = NOW + 5 * DAY;
  await e.ca.onMessage(msg(OWNER, '/awcancel 2 выдано ошибочно', {}));
  t('Warn: руководство отменило досрочно', W().w2.status === 'cancelled' && W().w2.cancelBy === OWNER && W().w2.cancelAt === NOW + 5 * DAY && W().w2.cancelReason === 'выдано ошибочно');
  t('Warn: отмена в журнале (кто, когда, причина)', LOG().some((x) => x.t === 'cancel' && x.n === 2 && x.actor === OWNER && x.reason === 'выдано ошибочно'));
  t('Warn: отменённое снято с очереди истечения', e.db.root.chatAdmin._global.wnPending[KEY + '_w2'] === undefined);
  await e.ca.onMessage(msg(S1, '/awarns', reply(A2)));
  t('Warn: после отмены действующих 2', e.sent().at(-1).includes('— 2 из 3'));

  // истечение срока: w1 выдано в NOW → истекает в NOW+20д
  e.clock.t = NOW + 20 * DAY + 1000;
  await e.ca.onMessage(msg(S1, '/awarns', reply(A2)));
  t('Warn: истёкшее не считается активным даже до проверки cron', e.sent().at(-1).includes('— 1 из 3'));
  const dmBefore = dmTo(A2).length;
  const done = await e.ca.sweepAll();
  t('Warn: cron пометил истёкшее', W().w1.status === 'expired' && W().w1.expiredAt === NOW + 20 * DAY + 1000 && e.db.root.chatAdmin._global.wnPending[KEY + '_w1'] === undefined, W().w1);
  t('Warn: администратору ушло уведомление об истечении', dmTo(A2).length === dmBefore + 1 && dmTo(A2).at(-1).includes('Срок предупреждения №1 истёк'));
  t('Warn: истечение записано в журнал', LOG().some((x) => x.t === 'expire' && x.n === 1));
  await e.ca.sweepAll();
  t('Warn: повторный проход не дублирует уведомление', dmTo(A2).length === dmBefore + 1);

  // удаление: запись пропадает, журнал помнит
  await e.ca.onMessage(msg(OWNER, '/awdel 2 дубликат', {}));
  t('Warn: удаление руководством', W().w2 === undefined && LOG().some((x) => x.t === 'delete' && x.n === 2 && x.details.includes('третье') === false && x.reason === 'дубликат'));

  // перезапуск бота: новый экземпляр видит всё из базы
  const e2 = createChatAdmin({ ...e.deps });
  await e2.onMessage(msg(S1, '/awhistory', reply(A2)));
  t('Warn: после «перезапуска» данные на месте', e.sent().at(-1).includes('Всего выдано: 2'));

  // повреждённая очередь не ломает cron
  e.db.root.chatAdmin._global.wnPending['мусор'] = 1; e.db.root.chatAdmin._global.wnPending[KEY + '_w999'] = 1;
  let ok = true; try { await e.ca.sweepAll(); } catch { ok = false; }
  t('Warn: мусор в очереди не ломает проход, чистится', ok && e.db.root.chatAdmin._global.wnPending['мусор'] === undefined);
}


// ---------- каналы ----------
{
  const CH = -1009876543210, CK = String(CH);
  const chan = { id: CH, type: 'channel', title: 'Мой канал' };
  const mcm = (from, status) => ({ my_chat_member: { chat: chan, from: { id: Number(from), first_name: 'X' }, new_chat_member: { status, user: { id: Number(BOT) } } } });
  // владелец проекта сделал бота админом канала → включается сам
  let e = makeEnv();
  await e.ca.onMyChatMember(mcm(OWNER, 'administrator'));
  t('канал: владелец проекта добавил бота админом — включено само', e.db.root.chatAdmin && e.db.root.chatAdmin[CK] && e.db.root.chatAdmin[CK].meta.enabled === true && e.db.root.chatAdmin[CK].meta.type === 'channel', e.db.root);
  t('канал: владельцу пришло личное сообщение', e.calls.some((c) => c.method === 'sendMessage' && c.payload.chat_id === Number(OWNER)));
  // чужой администратор канала — тишина и ни одной записи
  e = makeEnv({ statuses: { [ADMIN]: 'administrator' } });
  await e.ca.onMyChatMember(mcm(ADMIN, 'administrator'));
  t('канал: чужой администратор не включает бота', !e.db.root.chatAdmin && e.db.writes.length === 0, e.db.root);
  // публикации считаются
  e = makeEnv();
  await e.ca.onMyChatMember(mcm(OWNER, 'administrator'));
  await e.ca.onChannelPost({ message_id: 5, chat: chan, sender_chat: chan, date: NOW / 1000, text: 'секретный текст' });
  const day = dayKey(NOW);
  t('канал: публикация попала в счётчик, текста нет', e.db.root.chatAdmin[CK].daily[day].posts === 1 && !JSON.stringify(e.db.root).includes('секретный текст'), e.db.root);
  // не включённый канал не пишется
  e = makeEnv();
  await e.ca.onChannelPost({ message_id: 5, chat: chan, date: NOW / 1000, text: 'x' });
  t('канал: не включённый — ни одной записи', e.db.writes.length === 0);
  // вход подписчика: статистика есть, проверки «я не бот» и приветствия нет
  e = makeEnv();
  await e.ca.onMyChatMember(mcm(OWNER, 'administrator'));
  await e.ca.onChatMember({ chat_member: { chat: chan, from: { id: Number(VICTIM) }, date: NOW / 1000, old_chat_member: { status: 'left', user: { id: Number(VICTIM), first_name: 'V' } }, new_chat_member: { status: 'member', user: { id: Number(VICTIM), first_name: 'V' } } } });
  t('канал: вход подписчика учтён без «я не бот»', e.db.root.chatAdmin[CK].daily[day].joins === 1 && !e.calls.some((c) => c.method === 'restrictChatMember'), e.db.root.chatAdmin[CK]);
}

// ---------- чёрный список в новом канале ----------
{
  const CH = -1005550001111, chan = { id: CH, type: 'channel', title: 'Новый канал' };
  const e = makeEnv();
  e.db.root.chatAdmin = { _global: { bans: { 111111111: { name: 'A' }, 222222222: { name: 'B' } } } };
  await e.ca.onMyChatMember({ my_chat_member: { chat: chan, from: { id: Number(OWNER) }, new_chat_member: { status: 'administrator', user: { id: Number(BOT) } } } });
  const banned = e.calls.filter((c) => c.method === 'banChatMember' && c.payload.chat_id === CH).map((c) => c.payload.user_id).sort();
  t('канал: новый канал владельца сразу получает чёрный список', banned.join() === '111111111,222222222', banned);
}

// ---------- бан по устройству ----------
{
  const e = makeEnv();
  const r = await e.ca.globalBan({ id: '400400400', name: 'V' }, { reason: 'спам' }, { id: OWNER, name: 'Владелец' });
  t('устройства: метки забаненного попали в список устройств', r.ok && e.side.devBan[0] === '400400400' && /устройств заблокировано 2/.test(r.text), r);
  const rec = e.db.root.chatAdmin._global.bans['400400400'];
  t('устройства: метки сохранены в записи бана', Array.isArray(rec.devices) && rec.devices.length === 2, rec);
  await e.ca.globalUnban({ id: '400400400' }, { id: OWNER, name: 'Владелец' });
  t('устройства: при разбане метки снимаются', e.side.devUnban.length === 1 && e.side.devUnban[0].tags.length === 2, e.side.devUnban);
}
console.log(bad ? 'FAILED ' + bad : 'ALL PASS');
process.exit(bad ? 1 : 0);
