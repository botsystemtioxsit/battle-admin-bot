// Запуск ИИ-ассистента через GitHub Actions — основной способ по
// умолчанию (см. .github/workflows/assistant.yml и вкладку "Ассистент" в
// src/admin.html). Не требует стороннего сайта: секрет ANTHROPIC_API_KEY
// лежит в Settings → Secrets and variables → Actions этого репозитория —
// том же месте, где уже хранятся секреты для других workflow (см.
// build-obfuscated.yml и т.п.). Плата за это — задержка: раннер GitHub
// поднимается не мгновенно, обычно ответ приходит через 20–60 секунд
// после нажатия "Отправить" в панели, а не сразу как в чате.
//
// Обмен с клиентом идёт через саму Firebase RTDB (она и так публично
// читается/пишется, см. database.rules.json в репозитории index.html):
// admin.html кладёт запрос в assistantRequests/<requestId> и запускает
// этот workflow через workflow_dispatch с requestId во входных параметрах;
// этот скрипт читает запрос оттуда, прогоняет цикл ассистента (общая
// логика — lib/assistantCore.js, та же, что использует Vercel-вариант в
// api/claude-assistant.js) и пишет результат обратно в тот же путь —
// admin.html слушает его через db.ref(...).on('value').
const path = require('path');
const { dbGet, dbUpdate } = require(path.join(__dirname, '..', '..', 'lib', 'firebaseRest'));
const { runAssistantLoop } = require(path.join(__dirname, '..', '..', 'lib', 'assistantCore'));

async function main() {
  const requestId = process.env.REQUEST_ID;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!requestId) throw new Error('REQUEST_ID не передан workflow_dispatch (input requestId)');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY не задан в секретах репозитория (Settings → Secrets and variables → Actions)');

  const reqPath = `assistantRequests/${requestId}`;
  const reqDoc = await dbGet(reqPath);
  if (!reqDoc) throw new Error('Запрос ' + requestId + ' не найден в assistantRequests — возможно, admin.html не успел его записать до запуска');

  const messages = Array.isArray(reqDoc.messages) ? reqDoc.messages : [];
  const decisions = reqDoc.decisions && typeof reqDoc.decisions === 'object' ? reqDoc.decisions : null;
  if (!messages.length) throw new Error('assistantRequests/' + requestId + '/messages пуст');

  const result = await runAssistantLoop(messages, decisions, apiKey);
  const status = result.awaitingConfirmation ? 'awaiting_confirmation' : 'completed';
  await dbUpdate(reqPath, { status, updatedAt: Date.now(), result });
}

main().catch(async (err) => {
  console.error('run-assistant error:', err);
  try {
    const requestId = process.env.REQUEST_ID;
    if (requestId) {
      await dbUpdate(`assistantRequests/${requestId}`, { status: 'error', updatedAt: Date.now(), error: err.message || String(err) });
    }
  } catch (writeErr) {
    console.error('run-assistant: не удалось записать ошибку в базу тоже', writeErr);
  }
  process.exit(1);
});
