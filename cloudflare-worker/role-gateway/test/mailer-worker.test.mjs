// Рассылки внутри настоящего Worker'а: маршрут /mailer для панели, шифрование токенов ботов, отправка по cron (scheduled).
// Подставные: Google (токен), база (в памяти), Telegram Bot API (с учётом токена бота в адресе).
// Запуск: node cloudflare-worker/role-gateway/test/mailer-worker.test.mjs
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
const TOKEN_A = '111111111:AAAA-bbbbCCCCddddEEEEffffGGGGhhhh12';
const CHAT = '-1001234567890';

const db = { users: { 100: { role: 'superadmin' }, 200: { role: 'admin' } }, chatAdmin: { _global: { chats: { [CHAT]: { title: 'Наш чат' } } } } };
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

const tg = []; // { token, method, payload }
let failSendFor = null;
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
    if (method === 'PUT') { setPath(path, JSON.parse(init.body)); return new Response(init.body); }
    if (method === 'DELETE') { setPath(path, null); return new Response('null'); }
  }
  const m = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(url.href);
  if (m) {
    const payload = init.body ? JSON.parse(init.body) : {};
    tg.push({ token: m[1], method: m[2], payload });
    const json = (o) => new Response(JSON.stringify(o));
    if (m[2] === 'getMe') return m[1] === BOT_TOKEN ? json({ ok: true, result: { id: BOT_ID, username: 'my_bot', is_bot: true } }) : m[1] === TOKEN_A ? json({ ok: true, result: { id: 111111111, username: 'helper_a_bot', first_name: 'Помощник', is_bot: true } }) : json({ ok: false, description: 'Unauthorized' });
    if (m[2] === 'getChat') return json({ ok: true, result: { id: payload.chat_id, title: 'Чат', type: 'supergroup' } });
    if (m[2] === 'getChatMember') return json({ ok: true, result: { status: 'member' } });
    if (m[2] === 'sendMessage') return failSendFor === m[1] ? json({ ok: false, description: 'Forbidden: bot was kicked from the supergroup chat' }) : json({ ok: true, result: { message_id: 5 } });
    return json({ ok: true, result: true });
  }
  return new Response('not faked: ' + method + ' ' + url.href, { status: 599 });
};

let bad = 0;
const t = (name, cond, extra) => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : JSON.stringify(extra)); if (!cond) bad++; };
function initData(userId) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: Number(userId), first_name: 'T' }), query_id: 'q' });
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const sec = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', sec).update(check).digest('hex'));
  return params.toString();
}
async function panel(body, uid = OWNER) {
  const res = await worker.fetch(new Request('https://gw.test/mailer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData: initData(uid), ...body }) }), env);
  return { status: res.status, json: await res.json().catch(() => null) };
}

// ----- доступ -----
let res = await worker.fetch(new Request('https://gw.test/mailer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'list' }) }), env);
t('/mailer без подписи Telegram — 401', res.status === 401);
let r = await panel({ action: 'list' }, '200');
t('/mailer админу проекта (не владельцу) — 403', r.status === 403, r);
r = await panel({ action: 'nonsense' });
t('/mailer: неизвестное действие — 400', r.status === 400, r);
r = await panel({ action: 'list' });
t('/mailer list: главный бот и включённые чаты', r.status === 200 && r.json.bots[0].main === true && r.json.bots[0].username === 'my_bot' && r.json.chats[0].id === CHAT && r.json.campaigns.length === 0, r);

// ----- бот по токену -----
r = await panel({ action: 'bot-add', token: TOKEN_A });
t('бот добавлен', r.json.ok === true && r.json.bot.username === 'helper_a_bot', r);
const enc = db.mailer.bots['111111111'].enc;
t('токен в базе зашифрован (AES-GCM), открытого токена нет нигде', /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(enc) && !JSON.stringify(db).includes(TOKEN_A) && !JSON.stringify(db).includes('AAAA-bbbb'), enc);
r = await panel({ action: 'list' });
t('список: токен и шифр наружу не уходят', !JSON.stringify(r.json).includes(TOKEN_A) && !JSON.stringify(r.json).includes('v1.') && r.json.bots.length === 2, r.json.bots);
t('все записи в базу — только узел mailer', dbWrites.every((u) => Object.keys(u).every((k) => /^mailer(\/[A-Za-z0-9_-]{1,64}){0,8}$/.test(k))), dbWrites.flatMap((u) => Object.keys(u)).filter((k) => !/^mailer(\/[A-Za-z0-9_-]{1,64}){0,8}$/.test(k)));

// ----- рассылка и cron -----
const campaign = { name: 'Анонсы', chats: [CHAT], senders: ['main', '111111111'], variants: [{ text: 'Привет, {chat}!' }, { text: 'Второй текст', btn: { text: 'Открыть', url: 'https://example.com' } }], order: 'cycle', everyMin: 10, perDay: 48, tz: 'Europe/Berlin', hours: { from: 0, to: 0 } };
r = await panel({ action: 'save', campaign });
const cid = r.json.id;
t('рассылка создана на паузе', r.json.ok && db.mailer.campaigns[cid].status === 'paused', r);
let waited = null;
await worker.scheduled({ cron: '* * * * *' }, env, { waitUntil: (p) => { waited = p; } }); await waited;
t('cron: пауза — ничего не отправлено', !tg.some((c) => c.method === 'sendMessage'));
r = await panel({ action: 'check', id: cid });
t('проверка: оба бота состоят в чате', r.json.ok && r.json.rows.length === 2 && r.json.rows.every((x) => x.ok), r.json);
t('проверка: чужой бот спрашивает со своим токеном', tg.some((c) => c.method === 'getChatMember' && c.token === TOKEN_A) && tg.some((c) => c.method === 'getChatMember' && c.token === BOT_TOKEN));
r = await panel({ action: 'set-status', id: cid, status: 'active' });
t('запуск', r.json.ok === true);
tg.length = 0;
await worker.scheduled({ cron: '* * * * *' }, env, { waitUntil: (p) => { waited = p; } }); await waited;
const sends = tg.filter((c) => c.method === 'sendMessage');
t('cron: сообщение ушло (одним из ботов, расшифрованным токеном)', sends.length === 1 && [BOT_TOKEN, TOKEN_A].includes(sends[0].token) && sends[0].payload.chat_id === Number(CHAT) && sends[0].payload.text === 'Привет, Наш чат!', sends);
t('cron: счётчик и журнал записаны', db.mailer.campaigns[cid].stats.sent === 1 && Object.values(Object.values(db.mailer.log)[0]).length === 1);
r = await panel({ action: 'send-now', id: cid, chatId: CHAT });
const second = tg.filter((c) => c.method === 'sendMessage').at(-1);
t('«отправить сейчас»: второй вариант с кнопкой от второго бота', r.json.ok === true && second.payload.text === 'Второй текст' && second.payload.reply_markup.inline_keyboard[0][0].url === 'https://example.com' && second.token !== sends[0].token, { r: r.json, second });
r = await panel({ action: 'log' });
t('журнал для панели: без текстов сообщений', r.json.ok && r.json.log.length >= 2 && !JSON.stringify(r.json).includes('Привет'), r.json);

// ----- удаление -----
r = await panel({ action: 'bot-remove', id: '111111111' });
t('бот удалён: токен стёрт из базы и из рассылки', r.json.ok && !db.mailer.bots['111111111'] && !db.mailer.campaigns[cid].senders['111111111'], r);
r = await panel({ action: 'delete', id: cid });
t('рассылка удалена', r.json.ok && !db.mailer.campaigns[cid]);
r = await panel({ action: 'save', campaign: { ...campaign, chats: ['../../users'] } });
t('плохой номер чата — отказ без записи', r.json.ok === false && !Object.keys(db.mailer.campaigns || {}).length, r.json);

console.log(bad ? 'FAILED ' + bad : 'ALL PASS');
process.exit(bad ? 1 : 0);
