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
  const side = { gameBan: [], gameUnban: [], vcBan: [], vcUnban: [] };
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

// ---------- обычная работа в включённом чате ----------
async function enabled(extraMeta = {}, envOpts) {
  const e = makeEnv(envOpts);
  e.db.root.chatAdmin = { [KEY]: { meta: { enabled: true, title: 'Наш чат', ...extraMeta } } };
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
  t('капча: запись «ждём» — срок 3 минуты, номер сообщения', p && p.until === NOW + 180000 && p.msgId === msgCall.payload ? true : (p && p.until === NOW + 180000 && typeof p.msgId === 'number'), p);
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
  e.clock.t = NOW + 60000;
  t('таймер: рано — никого не выгоняем', (await e.ca.sweepCaptcha(KEY, true)) === 0 && !e.calls.some((c) => c.method === 'banChatMember'));
  e.clock.t = NOW + 181000;
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
  await e.ca.onMessage(msg(ADMIN, '/set captchaMin 5'));
  t('/set captchaMin 5', e.db.root.chatAdmin[KEY].meta.cfg.captchaMin === 5);
  await e.ca.onMessage(msg(ADMIN, '/set captchaMin 50'));
  t('/set captchaMin 50 — отказ', e.db.root.chatAdmin[KEY].meta.cfg.captchaMin === 5 && e.sent().at(-1).includes('от 1 до 10'));
  await e.ca.onMessage(msg(ADMIN, '/settings'));
  t('/settings показывает проверку «я не бот»', e.sent().at(-1).includes('captcha') && e.sent().at(-1).includes('captchaMin'));
}

console.log(bad ? 'FAILED ' + bad : 'ALL PASS');
process.exit(bad ? 1 : 0);
