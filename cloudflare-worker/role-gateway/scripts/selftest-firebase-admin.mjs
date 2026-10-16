// Самотест перед выкладкой Worker'а (запускается в GitHub Actions, см.
// .github/workflows/deploy-role-gateway.yml): может ли ключ сервисного
// аккаунта из секрета FIREBASE_SERVICE_ACCOUNT писать в Realtime Database
// ПОМИМО правил. Именно на это Worker будет полагаться после выкладки — если
// ключу не хватает роли, лучше узнать здесь, чем получить Worker, который не
// может выдать роль.
//
// Пишет только во временные узлы (_gateway_selftest_, users/_gateway_selftest_)
// и в конце всегда их удаляет.
import { getAdminAccessToken } from '../src/firebase-admin.mjs';

const DB = 'https://zolotaya-kletka-default-rtdb.firebaseio.com';
const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

if (!raw) fail('В GitHub не задан секрет FIREBASE_SERVICE_ACCOUNT (Settings → Secrets and variables → Actions).');

let token;
try {
  token = await getAdminAccessToken(raw);
} catch (err) {
  fail(`Не удалось получить токен сервисного аккаунта: ${err.message}`);
}
console.log('✓ токен сервисного аккаунта получен');

const withToken = (path) => `${DB}${path}?access_token=${encodeURIComponent(token)}`;
const scratch = `/_gateway_selftest_/run-${process.pid}-${new Date().getTime()}.json`;
const fakeUser = '/users/_gateway_selftest_.json';

async function cleanup() {
  for (const path of [scratch, fakeUser]) {
    try {
      await fetch(withToken(path), { method: 'DELETE' });
    } catch {
      // очистка — best effort, ниже всё равно падаем по настоящей причине
    }
  }
}

try {
  // 1. Запись и чтение с токеном.
  let res = await fetch(withToken(scratch), { method: 'PUT', body: JSON.stringify({ ok: true }) });
  if (res.status === 401 || res.status === 403) {
    fail(
      `Ключу FIREBASE_SERVICE_ACCOUNT отказано в записи в базу (HTTP ${res.status}). ` +
      'Ему не хватает роли «Firebase Realtime Database Admin» (roles/firebasedatabase.admin) — ' +
      'выдать в Google Cloud Console → IAM для этого сервисного аккаунта, либо взять ключ сервисного аккаунта firebase-adminsdk-*.',
    );
  }
  if (!res.ok) fail(`Запись с токеном не удалась: HTTP ${res.status} ${await res.text()}`);
  res = await fetch(withToken(scratch));
  const echoed = await res.json();
  if (!echoed || echoed.ok !== true) fail('Данные, записанные с токеном, не прочитались обратно.');
  console.log('✓ запись и чтение с токеном работают');

  // 2. Главное: запись, которую ПРАВИЛА отклонили бы клиенту (роль superadmin
  //    без ключа), с токеном проходит — значит токен действительно в обход правил.
  res = await fetch(withToken(fakeUser), { method: 'PUT', body: JSON.stringify({ role: 'superadmin' }) });
  if (!res.ok) {
    fail(`Запись role=superadmin с токеном отклонена (HTTP ${res.status}) — токен не обходит правила, Worker не сможет выдавать роли.`);
  }
  console.log('✓ токен обходит database.rules.json (роль superadmin записалась без ключа)');

  // 3. Контроль: тот же запрос БЕЗ токена должен отклоняться правилами. Если
  //    нет — это не сбой самотеста, но об этом надо знать.
  await fetch(withToken(fakeUser), { method: 'DELETE' });
  res = await fetch(`${DB}${fakeUser}`, { method: 'PUT', body: JSON.stringify({ role: 'superadmin' }) });
  if (res.ok) {
    console.log('::warning::Запись role=superadmin БЕЗ токена прошла — правила сейчас не защищают роль (после перехода на admin-режим правила нужно выложить).');
  } else {
    console.log(`✓ без токена та же запись отклоняется (HTTP ${res.status}) — правила работают`);
  }
} finally {
  await cleanup();
}

console.log('Самотест пройден.');
