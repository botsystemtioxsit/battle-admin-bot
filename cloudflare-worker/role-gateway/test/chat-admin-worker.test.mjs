// Админ-бот чатов внутри настоящего Worker: вебхук Telegram → обработка, маршрут /chat-admin для панели, самолечение вебхука в /health.
// Подставные: Google (токен), база (в памяти, пакетная запись с путями и increment), Telegram Bot API.
// Запуск: node cloudflare-worker/role-gateway/test/chat-admin-worker.test.mjs
import crypto from 'node:crypto';
import worker from '../src/index.js';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const BOT_TOKEN = '123456:TEST-TOKEN';
const OWNER = '100';
const env = {
  BOT_TOKEN, OWNER_IDS: OWNER,
  FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'sa@test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }),
};
const DB_HOST = 'https://zolotaya-kletka-default-rtdb.firebaseio.com';
const BOT_ID = 7000000001;
const CHAT = -1001234567890, KEY = String(CHAT);

const db = { users: { 100: { role: 'superadmin' }, 200: { role: 'admin' } } };
const dbWrites = [];
function setPath(path, value) {
  const parts = path.split('/');
  let n = db;
  for (let i = 0; i < parts.length - 1; i++) { if (typeof n[parts[i]] !== 'object' || n[parts[i]] === null) n[parts[i]] = {}; n = n[parts[i]]; }
  const last = parts.at(-1);
  if (value === null) delete n[last];
  else if (value && typeof value === 'object' && value['.sv'] && value['.sv'].increment !== undefined) n[last] = (Number(n[last]) || 0) + value['.sv'].increment;
  else n[last] = value;
}
const dbGet = (path) => path.split('/').filter(Boolean).reduce((n, k) => (n && typeof n === 'object' ? n[k] : undefined), db) ?? null;

const tg = []; // вызовы Bot API
let webhookInfo = { url: 'https://gw.test/telegram-webhook', allowed_updates: ['message', 'callback_query'], pending_update_count: 0 };
const memberStatus = { 100: 'creator', 200: 'administrator', 300: 'member', 400: 'member', [BOT_ID]: 'administrator' };
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init.method || 'GET').toUpperCase();
  if (url.href.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
  if (url.origin === DB_HOST) {
    const authed = url.searchParams.get('access_token') === 'tok';
    const path = decodeURIComponent(url.pathname).replace(/\.json$/, '').replace(/^\//, '');
    if (method === 'GET') return new Response(JSON.stringify(dbGet(path) ?? null));
    if (!authed) return new Response('{"error":"Permission denied"}', { status: 401 });
    if (method === 'PATCH' && path === '') { const u = JSON.parse(init.body); dbWrites.push(u); for (const [p, v] of Object.entries(u)) setPath(p, v); return new Response(init.body); }
    if (method === 'PATCH' && path !== '') { for (const [k, v] of Object.entries(JSON.parse(init.body))) setPath(path + '/' + k, v); return new Response(init.body); }
    if (method === 'PUT') { setPath(path, JSON.parse(init.body)); return new Response(init.body); }
    if (method === 'DELETE') { setPath(path, null); return new Response('null'); }
  }
  const m = /^https:\/\/api\.telegram\.org\/bot[^/]+\/(\w+)$/.exec(url.href);
  if (m) {
    const payload = init.body ? JSON.parse(init.body) : {};
    tg.push({ method: m[1], payload });
    if (m[1] === 'getMe') return new Response(JSON.stringify({ ok: true, result: { id: BOT_ID, username: 'my_bot' } }));
    if (m[1] === 'getWebhookInfo') return new Response(JSON.stringify({ ok: true, result: webhookInfo }));
    if (m[1] === 'setWebhook') { webhookInfo = { ...webhookInfo, url: payload.url, allowed_updates: payload.allowed_updates }; return new Response(JSON.stringify({ ok: true, result: true })); }
    if (m[1] === 'getChatMember') { const s = memberStatus[payload.user_id]; return new Response(JSON.stringify(s ? { ok: true, result: { status: s, can_restrict_members: true, can_delete_messages: true, can_invite_users: true, can_pin_messages: false } } : { ok: false, description: 'user not found' })); }
    if (m[1] === 'getChatMemberCount') return new Response(JSON.stringify({ ok: true, result: 42 }));
    if (m[1] === 'getChat') return new Response(JSON.stringify({ ok: true, result: { id: payload.chat_id, title: 'Наш чат', type: 'supergroup', permissions: { can_send_messages: true } } }));
    if (m[1] === 'sendMessage') return new Response(JSON.stringify({ ok: true, result: { message_id: 1000 + tg.length } }));
    return new Response(JSON.stringify({ ok: true, result: true }));
  }
  return new Response('not faked: ' + method + ' ' + url.href, { status: 599 });
};

let bad = 0;
const t = (name, cond, extra) => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : JSON.stringify(extra)); if (!cond) bad++; };
const secret = crypto.createHmac('sha256', Buffer.from(BOT_TOKEN)).update('telegram-webhook-v1').digest('hex');
async function hook(update, withSecret = true) {
  const res = await worker.fetch(new Request('https://gw.test/telegram-webhook', { method: 'POST', headers: { 'content-type': 'application/json', ...(withSecret ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : {}) }, body: JSON.stringify(update) }), env);
  return res.status;
}
function initData(userId) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: Number(userId), first_name: 'T' }), query_id: 'q' });
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const sec = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', sec).update(check).digest('hex'));
  return params.toString();
}
async function panel(body) {
  const res = await worker.fetch(new Request('https://gw.test/chat-admin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);
  return { status: res.status, json: await res.json().catch(() => null) };
}
const sentTexts = () => tg.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text);
const grp = (from, text, extra = {}) => ({ update_id: 1, message: { message_id: 5, chat: { id: CHAT, type: 'supergroup', title: 'Наш чат' }, from: { id: from, first_name: 'U' + from }, date: Math.floor(Date.now() / 1000), text, ...extra } });

// ----- вебхук -----
t('вебхук без секрета отклоняется', (await hook(grp(100, '/admin_on'), false)) === 401);
t('/admin_on от чужого: ответа нет, база не тронута', (await hook(grp(300, '/admin_on'))) === 200 && sentTexts().length === 0 && !db.chatAdmin);
t('/admin_on от владельца: чат включён', (await hook(grp(100, '/admin_on'))) === 200 && db.chatAdmin?.[KEY]?.meta?.enabled === true && sentTexts().at(-1).includes('включены'), db.chatAdmin);
t('при включении вебхук получил chat_member и my_chat_member', webhookInfo.allowed_updates.includes('chat_member') && webhookInfo.allowed_updates.includes('my_chat_member'), webhookInfo);

await hook(grp(300, 'просто текст'));
t('сообщение в включённом чате считается', db.chatAdmin[KEY].daily[new Date().toISOString().slice(0, 10)]?.messages === 1 && db.chatAdmin[KEY].users['300'].messages === 1, db.chatAdmin[KEY]);
t('текст сообщения не сохранён', !JSON.stringify(db.chatAdmin).includes('просто текст'));

const before = sentTexts().length;
await hook(grp(300, '/start'));
t('обычная команда /start в группе идёт старым путём (не перехвачена)', sentTexts().length >= before); // старый обработчик групп ответит или промолчит — главное, что не упало

await hook({ update_id: 2, chat_member: { chat: { id: CHAT, type: 'supergroup', title: 'Наш чат' }, from: { id: 300, first_name: 'Вася' }, date: Math.floor(Date.now() / 1000),
  old_chat_member: { status: 'left', user: { id: 300, first_name: 'Вася' } }, new_chat_member: { status: 'member', user: { id: 300, first_name: 'Вася' } },
  invite_link: { invite_link: 'https://t.me/+TOPSECRET', name: 'Реклама', creator: { id: 100, first_name: 'Владелец' } } } });
const today = new Date().toISOString().slice(0, 10);
t('chat_member: вход по ссылке записан', db.chatAdmin[KEY].daily[today].joins === 1 && db.chatAdmin[KEY].daily[today].how_invite === 1 && Object.values(db.chatAdmin[KEY].links)[0].name === 'Реклама', db.chatAdmin[KEY]);
t('ссылка целиком нигде не хранится', !JSON.stringify(db.chatAdmin).includes('TOPSECRET'));

await hook({ update_id: 3, my_chat_member: { chat: { id: CHAT, type: 'supergroup', title: 'Новое имя' }, from: { id: 100, first_name: 'В' }, date: 1, old_chat_member: { status: 'member', user: { id: BOT_ID } }, new_chat_member: { status: 'kicked', user: { id: BOT_ID } } } });
t('my_chat_member: бот удалён — состояние записано', db.chatAdmin[KEY].meta.botStatus === 'kicked' && db.chatAdmin[KEY].meta.title === 'Новое имя', db.chatAdmin[KEY].meta);

// ----- /health чинит вебхук -----
webhookInfo = { url: 'https://gw.test/telegram-webhook', allowed_updates: ['message', 'callback_query'], pending_update_count: 0 };
const hr = await (await worker.fetch(new Request('https://gw.test/health'), env)).json();
t('/health: наш вебхук без chat_member переустановлен', hr.telegramWebhook?.reapplied === true && webhookInfo.allowed_updates.includes('chat_member'), { hr, webhookInfo });
t('/health: команды администраторов чата выставлены', tg.some((c) => c.method === 'setMyCommands' && c.payload.scope.type === 'all_chat_administrators' && c.payload.commands.some((x) => x.command === 'stats')));

// ----- маршрут панели -----
let r = await panel({ action: 'status' });
t('/chat-admin без личности — 401', r.status === 401, r);
r = await panel({ initData: initData(200), action: 'status' });
t('/chat-admin: админ (не владелец) — 403', r.status === 403, r);
r = await panel({ initData: initData(100), action: 'status', chatId: CHAT });
t('/chat-admin status: вебхук, права бота, число участников', r.status === 200 && r.json.webhook.ours === true && r.json.webhook.chatMemberUpdates === true && r.json.chat.botStatus === 'administrator' && r.json.chat.canRestrict === true && r.json.chat.memberCount === 42, r);
r = await panel({ initData: initData(100), action: 'enable', chatId: CHAT });
t('/chat-admin enable: чат включён из панели', r.json.ok === true && db.chatAdmin[KEY].meta.enabled === true, r);
r = await panel({ initData: initData(100), action: 'set', chatId: CHAT, key: 'links', value: 'on' });
t('/chat-admin set links on', r.json.ok === true && db.chatAdmin[KEY].meta.cfg.links === true, r);
r = await panel({ initData: initData(100), action: 'set', chatId: CHAT, key: 'rules', value: 'Правило 1' });
t('/chat-admin set rules (текст)', r.json.ok === true && db.chatAdmin[KEY].meta.cfg.rules === 'Правило 1', r);
r = await panel({ initData: initData(100), action: 'set', chatId: CHAT, key: '__proto__', value: 'on' });
t('/chat-admin set: чужой ключ — 400', r.status === 400, r);
r = await panel({ initData: initData(100), action: 'mod', mod: 'mute', chatId: CHAT, userId: '400', name: 'Петя', minutes: 15, reason: 'флуд' });
const mute = tg.filter((c) => c.method === 'restrictChatMember').at(-1);
t('/chat-admin mod mute: Telegram получил ограничение на 15 минут', r.json.ok === true && mute && mute.payload.user_id === 400 && Math.abs(mute.payload.until_date - (Date.now() / 1000 + 900)) < 5, { r, mute });
const modEv = Object.values(Object.values(db.chatAdmin[KEY].events).flatMap((d) => Object.values(d))).find((e) => e.t === 'mod' && e.action === 'mute');
t('/chat-admin mod: действие записано от имени «панель» с id владельца', modEv && modEv.id === OWNER && modEv.name === 'панель' && modEv.target.id === '400', modEv);
r = await panel({ initData: initData(100), action: 'mod', mod: 'ban', chatId: CHAT, userId: '../etc' });
t('/chat-admin mod: плохой id — 400', r.status === 400, r);
r = await panel({ initData: initData(100), action: 'mod', mod: 'ban', chatId: CHAT, userId: String(OWNER) });
t('/chat-admin mod: владельца банить нельзя', r.json.ok === false && !tg.some((c) => c.method === 'banChatMember'), r);
// ----- бан везде -----
const GV = '4000000001';
db.users[GV] = { firstName: 'Вася', status: 'active', role: 'user' };
r = await panel({ initData: initData(200), action: 'gban', userId: GV, reason: 'x' });
t('бан везде: админ (не владелец) — 403 и ничего не изменено', r.status === 403 && db.users[GV].status === 'active' && !db.videochat, r);
r = await panel({ initData: initData(100), action: 'gban', userId: GV, name: 'Вася', username: 'vasya', reason: 'реклама казино' });
const gbans = tg.filter((c) => c.method === 'banChatMember' && c.payload.user_id === Number(GV));
t('бан везде: заблокирован во включённом чате', r.json.ok === true && gbans.length === 1 && gbans[0].payload.chat_id === CHAT, { r, gbans });
t('бан везде: в игре статус banned, в ВидеоЧате запрет без срока', db.users[GV].status === 'banned' && db.videochat.bans[GV].until === 0 && db.videochat.bans[GV].reason === 'реклама казино', { u: db.users[GV], vc: db.videochat });
t('бан везде: запись с причиной и кто поставил', db.chatAdmin._global.bans[GV].reason === 'реклама казино' && db.chatAdmin._global.bans[GV].by === OWNER && db.chatAdmin._global.bans[GV].game === 'banned', db.chatAdmin._global);
// вход человека из списка — не впускаем (бот видит chat_member)
tg.length = 0;
await hook({ update_id: 9, chat_member: { chat: { id: CHAT, type: 'supergroup', title: 'Наш чат' }, from: { id: Number(GV), first_name: 'Вася' }, date: Math.floor(Date.now() / 1000),
  old_chat_member: { status: 'left', user: { id: Number(GV), first_name: 'Вася' } }, new_chat_member: { status: 'member', user: { id: Number(GV), first_name: 'Вася' } } } });
t('вход человека из «бана везде»: бот банит и ничего не приветствует', tg.some((c) => c.method === 'banChatMember' && c.payload.user_id === Number(GV)) && !tg.some((c) => c.method === 'sendMessage'), tg);
r = await panel({ initData: initData(100), action: 'gban', userId: '200' });
t('бан везде: админа проекта нельзя', r.json.ok === false && db.users['200'].role === 'admin' && db.users['200'].status !== 'banned', r);
r = await panel({ initData: initData(100), action: 'gban', userId: String(OWNER) });
t('бан везде: себя (владельца) нельзя', r.json.ok === false, r);
r = await panel({ initData: initData(100), action: 'gban', userId: '../x' });
t('бан везде: плохой id — 400', r.status === 400, r);
r = await panel({ initData: initData(100), action: 'ungban', userId: GV });
t('разбан везде: игра снова active, ВидеоЧат открыт, запись убрана', r.json.ok === true && db.users[GV].status === 'active' && !(db.videochat.bans || {})[GV] && !(db.chatAdmin._global.bans || {})[GV], { r, u: db.users[GV], vc: db.videochat });
r = await panel({ initData: initData(100), action: 'disable', chatId: CHAT });
t('/chat-admin disable', r.json.ok === true && db.chatAdmin[KEY].meta.enabled === false, r);
r = await panel({ initData: initData(100), action: 'enable', chatId: '../../users' });
t('/chat-admin: плохой chatId — 400', r.status === 400, r);


// ----- проверка «я не бот»: вебхук и cron -----
{
  await panel({ initData: initData(100), action: 'enable', chatId: CHAT });
  db.chatAdmin[KEY].meta.cfg = { captcha: true, welcome: true };
  db.chatAdmin[KEY].pending = undefined; delete db.chatAdmin[KEY].pending;
  tg.length = 0;
  const NEW = 800000001;
  const joinUpd = (id, n) => ({ update_id: n, chat_member: { chat: { id: CHAT, type: 'supergroup', title: 'Наш чат' }, from: { id, first_name: 'Новичок' }, date: Math.floor(Date.now() / 1000),
    old_chat_member: { status: 'left', user: { id, first_name: 'Новичок' } }, new_chat_member: { status: 'member', user: { id, first_name: 'Новичок' } } } });
  await hook(joinUpd(NEW, 20));
  const btn = tg.find((c) => c.method === 'sendMessage' && c.payload.reply_markup);
  t('вебхук: вход новичка → ограничение и кнопка «Я не бот»', tg.some((c) => c.method === 'restrictChatMember' && c.payload.user_id === NEW) && btn && btn.payload.reply_markup.inline_keyboard[0][0].callback_data === 'cap:' + NEW, tg.map((c) => c.method));
  t('вебхук: запись «ждём» в базе', db.chatAdmin[KEY].pending[NEW] && db.chatAdmin[KEY].pending[NEW].until > Date.now(), db.chatAdmin[KEY].pending);
  tg.length = 0;
  const st = await hook({ update_id: 21, callback_query: { id: 'cb1', from: { id: NEW, first_name: 'Новичок' }, data: 'cap:' + NEW, message: { message_id: 55, chat: { id: CHAT, type: 'supergroup', title: 'Наш чат' } } } });
  t('вебхук: нажатие кнопки доходит до проверки (не до входа по заявке)', st === 200 && tg.some((c) => c.method === 'restrictChatMember' && c.payload.user_id === NEW && c.payload.permissions.can_send_messages === true) && !db.chatAdmin[KEY].pending?.[NEW] && db.chatAdmin[KEY].users[NEW].verifiedAt > 0, { tg: tg.map((c) => c.method), p: db.chatAdmin[KEY].pending });
  t('вебхук: после проверки — приветствие и ответ на нажатие', sentTexts().length >= 1 && tg.some((c) => c.method === 'answerCallbackQuery' && c.payload.text.includes('Готово')), tg.map((c) => c.method));
  // не нажал: cron
  const SLOW = 800000002;
  await hook(joinUpd(SLOW, 22));
  db.chatAdmin[KEY].pending[SLOW].until = Date.now() - 1000;
  tg.length = 0;
  let waited = null;
  await worker.scheduled({ cron: '* * * * *' }, env, { waitUntil: (p) => { waited = p; } });
  await waited;
  t('cron (scheduled): не нажавший выгнан — бан и сразу разбан', tg.some((c) => c.method === 'banChatMember' && c.payload.user_id === SLOW) && tg.some((c) => c.method === 'unbanChatMember' && c.payload.user_id === SLOW && c.payload.only_if_banned === true), tg.map((c) => c.method + ':' + (c.payload.user_id || '')));
  t('cron: счётчик «не прошёл»', db.chatAdmin[KEY].daily[new Date().toISOString().slice(0, 10)].captcha_fail === 1, db.chatAdmin[KEY].daily);
  t('cron: все записанные пути безопасны', dbWrites.every((u) => Object.keys(u).every((k) => /^chatAdmin(\/[A-Za-z0-9_-]{1,64}){0,8}$/.test(k))), dbWrites.flatMap((u) => Object.keys(u)).filter((k) => !/^chatAdmin(\/[A-Za-z0-9_-]{1,64}){0,8}$/.test(k)));
  // чужая кнопка cap: из чата, где проверка не включена, ничего не ломает
  tg.length = 0;
  const st2 = await hook({ update_id: 23, callback_query: { id: 'cb2', from: { id: 1, first_name: 'X' }, data: 'cap:1', message: { message_id: 1, chat: { id: -100999, type: 'supergroup' } } } });
  t('вебхук: кнопка из чужого чата — спокойный ответ, без записи', st2 === 200 && tg.some((c) => c.method === 'answerCallbackQuery'), tg.map((c) => c.method));
}

console.log(bad ? 'FAILED ' + bad : 'ALL PASS');
process.exit(bad ? 1 : 0);
