#!/usr/bin/env node
// Мини-CLI для рутинных админских действий из терминала, в довесок к
// веб-панели (src/admin.html) — не замена ей: нет живого обновления, нет
// подтверждающих карточек как у ассистента, только то, что явно набрано
// руками. Использует ту же lib/firebaseRest.js, что и ассистент
// (api/claude-assistant.js, .github/scripts/run-assistant.js) — публичный
// REST Firebase (база и так открыта на чтение/запись, см. CLAUDE.md), так
// что никакого API-ключа этому скрипту не нужно вообще, только Node 18+
// (нужен глобальный fetch).
//
// Использование:
//   node cli/battle-admin.js find <telegramId|PLR-XXXXXX>
//   node cli/battle-admin.js ban <telegramId> [причина]
//   node cli/battle-admin.js unban <telegramId>
//   node cli/battle-admin.js lockdown on [сообщение]
//   node cli/battle-admin.js lockdown off
//   node cli/battle-admin.js maintenance on [сообщение]
//   node cli/battle-admin.js maintenance off
//
// ban/lockdown спрашивают подтверждение y/N в терминале — это единственная
// защита от опечатки, тот же принцип "человек подтверждает разрушающее
// действие", что и везде в проекте, просто в виде вопроса в консоли, а не
// кнопки. Каждое изменяющее действие попадает в Журнал действий панели
// (logs) с пометкой "Терминал", как и всё остальное.
const readline = require('readline');
const path = require('path');
const { dbGet, dbSet, dbUpdate, dbPush, DB_URL } = require(path.join(__dirname, '..', 'lib', 'firebaseRest'));

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question + ' [y/N] ', (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

async function logAction(actionType, targetKey, details) {
  try {
    await dbPush('logs', {
      timestamp: Date.now(),
      actorPlayerId: 'CLI',
      actorName: 'Терминал (' + (process.env.USER || process.env.USERNAME || 'неизвестно') + ')',
      actionType,
      targetKey: targetKey || '—',
      targetName: '—',
      targetPlayerId: '—',
      details: details || '',
    });
  } catch (err) {
    console.error('(не удалось записать в журнал действий: ' + (err.message || err) + ')');
  }
}

async function findByPlayerId(playerId) {
  const url = `${DB_URL}/users.json?orderBy=%22playerId%22&equalTo=%22${encodeURIComponent(playerId)}%22`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Firebase ' + res.status);
  return res.json();
}

function printUser(id, user) {
  if (!user) { console.log('Не найден:', id); return; }
  console.log([
    `Telegram/uid:   ${id}`,
    `ID игрока:      ${user.playerId || '—'}`,
    `Имя:            ${user.firstName || '—'}`,
    `Роль:           ${user.role || 'user'}`,
    `Статус:         ${user.status || 'active'}`,
    `Очки (ELO):     ${user.points ?? '—'}`,
    `Звёзды:         ${user.starsBalance ?? '—'}`,
  ].join('\n'));
}

async function cmdFind(arg) {
  if (!arg) { console.error('Укажи telegramId или PLR-XXXXXX'); process.exitCode = 1; return; }
  if (/^PLR-/i.test(arg)) {
    const matches = await findByPlayerId(arg.toUpperCase());
    const entries = Object.entries(matches || {});
    if (!entries.length) { console.log('Не найден:', arg); return; }
    entries.forEach(([uid, user]) => printUser(uid, user));
    return;
  }
  printUser(arg, await dbGet('users/' + arg));
}

async function cmdBan(telegramId, reason) {
  if (!telegramId) { console.error('Укажи telegramId'); process.exitCode = 1; return; }
  const user = await dbGet('users/' + telegramId);
  if (!user) { console.error('Игрок не найден:', telegramId); process.exitCode = 1; return; }
  printUser(telegramId, user);
  if (!(await confirm(`Забанить этого игрока?${reason ? ' (' + reason + ')' : ''}`))) { console.log('Отменено.'); return; }
  await dbUpdate('users/' + telegramId, { status: 'banned' });
  await logAction('cli_ban', telegramId, reason || '');
  console.log('Забанен:', telegramId);
}

async function cmdUnban(telegramId) {
  if (!telegramId) { console.error('Укажи telegramId'); process.exitCode = 1; return; }
  await dbUpdate('users/' + telegramId, { status: 'active' });
  await logAction('cli_unban', telegramId, '');
  console.log('Разбанен:', telegramId);
}

async function cmdLockdown(state, message) {
  if (state !== 'on' && state !== 'off') { console.error('Укажи on или off'); process.exitCode = 1; return; }
  const on = state === 'on';
  if (on && !(await confirm('Включить АВАРИЙНЫЙ РЕЖИМ — доступ к игре закроется для всех, включая супердоступ?'))) {
    console.log('Отменено.');
    return;
  }
  await dbSet('config/emergencyLockdown', on);
  if (on) await dbSet('config/emergencyMessage', message || null);
  await logAction('cli_lockdown', 'config', on ? ('включён' + (message ? ': ' + message : '')) : 'выключен');
  console.log('Аварийный режим:', on ? 'ВКЛЮЧЁН' : 'выключен');
}

async function cmdMaintenance(state, message) {
  if (state !== 'on' && state !== 'off') { console.error('Укажи on или off'); process.exitCode = 1; return; }
  const on = state === 'on';
  await dbSet('config/maintenanceMode', on);
  if (on) await dbSet('config/maintenanceMessage', message || null);
  await logAction('cli_maintenance', 'config', on ? ('включён' + (message ? ': ' + message : '')) : 'выключен');
  console.log('Режим обслуживания:', on ? 'включён' : 'выключен');
}

const USAGE = `Использование:
  node cli/battle-admin.js find <telegramId|PLR-XXXXXX>
  node cli/battle-admin.js ban <telegramId> [причина]
  node cli/battle-admin.js unban <telegramId>
  node cli/battle-admin.js lockdown on|off [сообщение]
  node cli/battle-admin.js maintenance on|off [сообщение]`;

async function main() {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case 'find': await cmdFind(rest[0]); break;
    case 'ban': await cmdBan(rest[0], rest.slice(1).join(' ')); break;
    case 'unban': await cmdUnban(rest[0]); break;
    case 'lockdown': await cmdLockdown(rest[0], rest.slice(1).join(' ')); break;
    case 'maintenance': await cmdMaintenance(rest[0], rest.slice(1).join(' ')); break;
    default:
      console.log(USAGE);
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((err) => { console.error('Ошибка:', err.message || err); process.exitCode = 1; });
