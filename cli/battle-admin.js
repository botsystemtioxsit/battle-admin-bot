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
// Два режима запуска:
//   node cli/battle-admin.js                     — интерактивная оболочка
//                                                    (просто battle-admin>,
//                                                    команды по одной, exit
//                                                    чтобы выйти)
//   node cli/battle-admin.js <команда> [аргументы] — разовый запуск,
//                                                    удобно для cron/скриптов
//
// Команды одинаковые что в оболочке, что разово:
//   find <telegramId|PLR-XXXXXX>
//   ban <telegramId> [причина]
//   unban <telegramId>
//   lockdown on|off [сообщение]
//   maintenance on|off [сообщение]
//   help
//   exit / quit (только внутри оболочки)
//
// ban/lockdown спрашивают подтверждение y/N — единственная защита от
// опечатки, тот же принцип "человек подтверждает разрушающее действие",
// что и везде в проекте, просто в виде вопроса в консоли, а не кнопки.
// Каждое изменяющее действие попадает в Журнал действий панели (logs) с
// пометкой "Терминал".
const readline = require('readline');
const path = require('path');
const { dbGet, dbSet, dbUpdate, dbPush, DB_URL } = require(path.join(__dirname, '..', 'lib', 'firebaseRest'));

// Минимум ANSI-цвета, без внешних зависимостей — только там, где реально
// помогает читать вывод (заголовок, ошибки, предупреждения).
const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

let sharedRl = null;
function getRl() {
  if (!sharedRl) sharedRl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return sharedRl;
}
function ask(question) {
  return new Promise((resolve) => getRl().question(question, resolve));
}
async function confirm(question) {
  const answer = await ask(question + c.dim(' [y/N] '));
  return answer.trim().toLowerCase() === 'y';
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
    console.error(c.dim('(не удалось записать в журнал действий: ' + (err.message || err) + ')'));
  }
}

async function findByPlayerId(playerId) {
  const url = `${DB_URL}/users.json?orderBy=%22playerId%22&equalTo=%22${encodeURIComponent(playerId)}%22`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Firebase ' + res.status);
  return res.json();
}

function printUser(id, user) {
  if (!user) { console.log(c.yellow('Не найден: ' + id)); return; }
  console.log([
    c.bold('Telegram/uid:   ') + id,
    c.bold('ID игрока:      ') + (user.playerId || '—'),
    c.bold('Имя:            ') + (user.firstName || '—'),
    c.bold('Роль:           ') + (user.role || 'user'),
    c.bold('Статус:         ') + (user.status || 'active'),
    c.bold('Очки (ELO):     ') + (user.points ?? '—'),
    c.bold('Звёзды:         ') + (user.starsBalance ?? '—'),
  ].join('\n'));
}

async function cmdFind(arg) {
  if (!arg) { console.error(c.red('Укажи telegramId или PLR-XXXXXX')); return 1; }
  if (/^PLR-/i.test(arg)) {
    const matches = await findByPlayerId(arg.toUpperCase());
    const entries = Object.entries(matches || {});
    if (!entries.length) { console.log(c.yellow('Не найден: ' + arg)); return 0; }
    entries.forEach(([uid, user]) => printUser(uid, user));
    return 0;
  }
  printUser(arg, await dbGet('users/' + arg));
  return 0;
}

async function cmdBan(telegramId, reason) {
  if (!telegramId) { console.error(c.red('Укажи telegramId')); return 1; }
  const user = await dbGet('users/' + telegramId);
  if (!user) { console.error(c.red('Игрок не найден: ' + telegramId)); return 1; }
  printUser(telegramId, user);
  if (!(await confirm(`Забанить этого игрока?${reason ? ' (' + reason + ')' : ''}`))) { console.log('Отменено.'); return 0; }
  await dbUpdate('users/' + telegramId, { status: 'banned' });
  await logAction('cli_ban', telegramId, reason || '');
  console.log(c.green('Забанен: ' + telegramId));
  return 0;
}

async function cmdUnban(telegramId) {
  if (!telegramId) { console.error(c.red('Укажи telegramId')); return 1; }
  await dbUpdate('users/' + telegramId, { status: 'active' });
  await logAction('cli_unban', telegramId, '');
  console.log(c.green('Разбанен: ' + telegramId));
  return 0;
}

async function cmdLockdown(state, message) {
  if (state !== 'on' && state !== 'off') { console.error(c.red('Укажи on или off')); return 1; }
  const on = state === 'on';
  if (on && !(await confirm('Включить ' + c.bold('АВАРИЙНЫЙ РЕЖИМ') + ' — доступ к игре закроется для всех, включая супердоступ?'))) {
    console.log('Отменено.');
    return 0;
  }
  await dbSet('config/emergencyLockdown', on);
  if (on) await dbSet('config/emergencyMessage', message || null);
  await logAction('cli_lockdown', 'config', on ? ('включён' + (message ? ': ' + message : '')) : 'выключен');
  console.log((on ? c.red('Аварийный режим: ВКЛЮЧЁН') : c.green('Аварийный режим: выключен')));
  return 0;
}

async function cmdMaintenance(state, message) {
  if (state !== 'on' && state !== 'off') { console.error(c.red('Укажи on или off')); return 1; }
  const on = state === 'on';
  await dbSet('config/maintenanceMode', on);
  if (on) await dbSet('config/maintenanceMessage', message || null);
  await logAction('cli_maintenance', 'config', on ? ('включён' + (message ? ': ' + message : '')) : 'выключен');
  console.log(on ? c.yellow('Режим обслуживания: включён') : c.green('Режим обслуживания: выключен'));
  return 0;
}

const USAGE = `${c.bold('Команды:')}
  find <telegramId|PLR-XXXXXX>        — найти игрока
  ban <telegramId> [причина]          — забанить (спросит подтверждение)
  unban <telegramId>                  — разбанить
  lockdown on|off [сообщение]         — аварийный режим (спросит подтверждение при включении)
  maintenance on|off [сообщение]      — режим обслуживания
  help                                — эта справка
  exit / quit                         — выйти из оболочки`;

// Простой токенайзер: делит строку на аргументы по пробелам, но не рвёт
// текст в кавычках — иначе "причина в несколько слов" не набрать.
function tokenize(line) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

async function dispatch(cmd, rest) {
  switch (cmd) {
    case 'find': return cmdFind(rest[0]);
    case 'ban': return cmdBan(rest[0], rest.slice(1).join(' '));
    case 'unban': return cmdUnban(rest[0]);
    case 'lockdown': return cmdLockdown(rest[0], rest.slice(1).join(' '));
    case 'maintenance': return cmdMaintenance(rest[0], rest.slice(1).join(' '));
    case 'help': console.log(USAGE); return 0;
    default:
      console.log(c.red('Неизвестная команда: ' + cmd));
      console.log(USAGE);
      return 1;
  }
}

async function runOnce(argv) {
  const [cmd, ...rest] = argv;
  const code = await dispatch(cmd, rest);
  process.exitCode = code;
}

async function runShell() {
  console.log(c.bold(c.cyan('БАТТЛ · Админ-CLI')) + c.dim(' — интерактивная оболочка. "help" — список команд, "exit" — выход.'));
  console.log();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const line = (await ask(c.green('battle-admin> '))).trim();
    if (!line) continue;
    const [cmd, ...rest] = tokenize(line);
    if (cmd === 'exit' || cmd === 'quit') break;
    try {
      await dispatch(cmd, rest);
    } catch (err) {
      console.error(c.red('Ошибка: ' + (err.message || err)));
    }
    console.log();
  }
  getRl().close();
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length) {
    await runOnce(argv);
    if (sharedRl) sharedRl.close();
  } else {
    await runShell();
  }
}

main().catch((err) => { console.error(c.red('Ошибка: ' + (err.message || err))); process.exitCode = 1; });
