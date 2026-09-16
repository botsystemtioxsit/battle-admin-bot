// Тонкая обёртка над публичным REST-эндпоинтом Firebase RTDB — без Admin
// SDK и без сервисного аккаунта, потому что database.rules.json (репозиторий
// index.html) открыт на чтение/запись всем (.read/.write: true) — тот же
// приём, что уже используется в .github/workflows/sync-error-reports.yml
// и db-snapshot.yml (battle-data-admin-bot). databaseURL — публичная часть
// firebaseConfig, не секрет (см. комментарий в src/admin.html рядом с ним).
const DB_URL = 'https://zolotaya-kletka-default-rtdb.firebaseio.com';

function pathUrl(path, query) {
  const clean = String(path || '').replace(/^\/+|\/+$/g, '');
  const q = query ? ('?' + query) : '';
  return `${DB_URL}/${clean}.json${q}`;
}

async function dbGet(path, { shallow } = {}) {
  const res = await fetch(pathUrl(path, shallow ? 'shallow=true' : ''));
  if (!res.ok) throw new Error(`Firebase GET ${path} -> ${res.status}`);
  return res.json();
}

async function dbSet(path, value) {
  const res = await fetch(pathUrl(path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value === undefined ? null : value),
  });
  if (!res.ok) throw new Error(`Firebase PUT ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function dbUpdate(path, updates) {
  const res = await fetch(pathUrl(path), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`Firebase PATCH ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function dbDelete(path) {
  const res = await fetch(pathUrl(path), { method: 'DELETE' });
  if (!res.ok) throw new Error(`Firebase DELETE ${path} -> ${res.status}`);
  return res.json();
}

async function dbPush(path, value) {
  const key = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  await dbSet(`${path}/${key}`, value);
  return key;
}

module.exports = { dbGet, dbSet, dbUpdate, dbDelete, dbPush, DB_URL };
