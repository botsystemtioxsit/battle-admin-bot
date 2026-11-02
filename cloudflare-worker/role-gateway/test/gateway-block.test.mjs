// Проверка маршрута POST /gateway-block без сети: настоящий код Worker'а, подставные Google (токен) и база (в памяти).
// Запуск: node cloudflare-worker/role-gateway/test/gateway-block.test.mjs
import crypto from 'node:crypto';
import worker from '../src/index.js';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const BOT_TOKEN = '123456:TEST-TOKEN';
const env = {
  BOT_TOKEN,
  OWNER_IDS: '100',
  FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'sa@test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }),
};

// --- подставная база: дерево в памяти, REST как у Firebase (GET/PUT/DELETE по .json, только с access_token) ---
const db = {};
const DB_HOST = 'https://zolotaya-kletka-default-rtdb.firebaseio.com';
function walk(path, create) {
  const parts = path.split('/').filter(Boolean);
  let node = db;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) { if (!create) return [undefined, parts.at(-1)]; node[parts[i]] = {}; }
    node = node[parts[i]];
  }
  return [node, parts.at(-1)];
}
let writes = [];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init.method || 'GET').toUpperCase();
  if (url.href.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { headers: { 'content-type': 'application/json' } });
  if (url.origin === DB_HOST) {
    const path = decodeURIComponent(url.pathname).replace(/\.json$/, '');
    const authed = url.searchParams.get('access_token') === 'tok';
    const [parent, key] = walk(path, method === 'PUT');
    if (method === 'GET') {
      const v = parent === undefined || key === undefined ? db : parent[key];
      return new Response(JSON.stringify(v === undefined ? null : v), { status: 200 });
    }
    if (!authed) return new Response('{"error":"Permission denied"}', { status: 401 });
    if (method === 'PUT') { parent[key] = JSON.parse(init.body); writes.push(['PUT', path]); return new Response(init.body, { status: 200 }); }
    if (method === 'DELETE') { if (parent) delete parent[key]; writes.push(['DELETE', path]); return new Response('null', { status: 200 }); }
  }
  return new Response('not faked: ' + method + ' ' + url.href, { status: 599 });
};

// --- подпись Telegram initData ---
function initData(userId, ageSec = 0) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000) - ageSec), user: JSON.stringify({ id: Number(userId), first_name: 'T' }), query_id: 'q' });
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}
async function call(body) {
  const res = await worker.fetch(new Request('https://gw.test/gateway-block', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);
  return { status: res.status, json: await res.json().catch(() => null) };
}

let bad = 0;
const t = (name, cond, extra) => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : JSON.stringify(extra)); if (!cond) bad++; };

const ID = '0123456789abcdef01234567', ID2 = 'abcdefabcdefabcdefabcdef';
const DEV = 'fedcba9876543210fedcba9876543210';
db.users = { 100: { role: 'superadmin' }, 200: { role: 'admin' }, 300: { role: 'user' } };
db.gatewayAccounts = { [ID]: { name: 'Alex', createdAt: 1, dev: DEV }, [ID2]: { name: 'Bob', createdAt: 2, dev: DEV } };

let r = await call({ initData: initData(100), id: ID, blocked: true, reason: 'продаёт доступ  за деньги\n<b>x</b>‮' });
t('суперадмин блокирует аккаунт и компьютер', r.status === 200 && r.json.accountBlocked === true && r.json.deviceBlocked === true && r.json.dev === DEV, r);
t('запись gatewayBlocks/<id>: время, причина (одна строка, без управляющих), кто', db.gatewayBlocks?.[ID]?.at > 0 && db.gatewayBlocks[ID].reason === 'продаёт доступ за деньги <b>x</b>' && db.gatewayBlocks[ID].by === '100', db.gatewayBlocks);
t('запись gatewayBlockedDevices/<dev> со ссылкой на аккаунт', db.gatewayBlockedDevices?.[DEV]?.account === ID, db.gatewayBlockedDevices);

r = await call({ initData: initData(100), id: ID2, blocked: true, reason: 'второй аккаунт', alsoDevice: false });
t('alsoDevice:false — компьютер не трогаем', r.status === 200 && r.json.deviceBlocked === false && db.gatewayBlockedDevices[DEV].account === ID, r);

r = await call({ initData: initData(100), id: ID2, blocked: false });
t('разблокировка чужого аккаунта не снимает блок компьютера, поставленный из-за другого', r.status === 200 && db.gatewayBlockedDevices?.[DEV]?.account === ID && !db.gatewayBlocks?.[ID2], { r, dev: db.gatewayBlockedDevices });

r = await call({ initData: initData(100), id: ID, blocked: false });
t('разблокировка снимает аккаунт и свой компьютер', r.status === 200 && !db.gatewayBlocks?.[ID] && !db.gatewayBlockedDevices?.[DEV], { r, db: db.gatewayBlocks, dev: db.gatewayBlockedDevices });

await call({ initData: initData(100), dev: DEV, blocked: true, reason: 'только компьютер' });
t('блокировка только по номеру компьютера', db.gatewayBlockedDevices?.[DEV]?.reason === 'только компьютер' && !db.gatewayBlockedDevices[DEV].account, db.gatewayBlockedDevices);
await call({ initData: initData(100), dev: DEV, blocked: false });
t('разблокировка компьютера по номеру', !db.gatewayBlockedDevices?.[DEV], db.gatewayBlockedDevices);

writes = [];
r = await call({ initData: initData(200), id: ID, blocked: true, reason: 'x' });
t('обычный админ не может (403), в базу ничего не записано', r.status === 403 && writes.length === 0, { r, writes });
r = await call({ initData: initData(300), id: ID, blocked: true });
t('игрок не может (403)', r.status === 403, r);
r = await call({ initData: initData(100, 99999), id: ID, blocked: true });
t('устаревшая initData отклонена (401)', r.status === 401, r);
r = await call({ id: ID, blocked: true });
t('без личности отклонено (401)', r.status === 401, r);
r = await call({ initData: initData(100), id: '../users/100', blocked: true });
t('путь в номере аккаунта отклонён (400)', r.status === 400 && writes.length === 0, r);
r = await call({ initData: initData(100), id: ID, blocked: 'yes' });
t('blocked не булево — 400', r.status === 400, r);
r = await call({ initData: initData(100), blocked: true });
t('нужен id или dev — 400', r.status === 400, r);
r = await call({ initData: initData(100), dev: 'XYZ', blocked: true });
t('плохой номер компьютера — 400', r.status === 400, r);
t('ни одна проверка не изменила users/', JSON.stringify(db.users) === JSON.stringify({ 100: { role: 'superadmin' }, 200: { role: 'admin' }, 300: { role: 'user' } }), db.users);

console.log(bad ? 'FAILED ' + bad : 'ALL PASS');
process.exit(bad ? 1 : 0);
