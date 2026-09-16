// ИИ-ассистент админ-панели — способ запуска через Vercel (мгновенный
// ответ, но требует один раз завести бесплатный проект на vercel.com и
// вписать туда ANTHROPIC_API_KEY). Основной способ по умолчанию — GitHub
// Actions (.github/workflows/assistant.yml + .github/scripts/run-assistant.js,
// без стороннего сайта, но с задержкой в десятки секунд) — см. src/admin.html,
// вкладка "Ассистент". Вся общая логика (инструменты, цикл tool-use,
// подтверждение изменяющих действий человеком) — в lib/assistantCore.js,
// этот файл только маршрутизирует HTTP-запрос.
const { runAssistantLoop } = require('../lib/assistantCore');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ASSISTANT_SECRET = process.env.ASSISTANT_SECRET; // необязательный общий секрет — см. README, та же идея, что WEBHOOK_SECRET у бота

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  if (!ANTHROPIC_API_KEY) { res.status(500).json({ error: 'ANTHROPIC_API_KEY не настроен на сервере (Vercel → Settings → Environment Variables).' }); return; }
  // Необязательная лёгкая проверка — как WEBHOOK_SECRET у бота: не настоящий
  // контроль доступа (сам эндпоинт публичный, а panel-side гейт по роли —
  // UI-условность, как и везде в проекте), но отсекает случайное/массовое
  // сканирование URL ботами.
  if (ASSISTANT_SECRET && req.headers['x-assistant-secret'] !== ASSISTANT_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const body = req.body || {};
  const clientMessages = Array.isArray(body.messages) ? body.messages : [];
  // decisions — {[tool_use_id]: 'approved'|'rejected'} для действий, которые
  // сервер вернул как pendingActions в ПРЕДЫДУЩЕМ ответе. Когда он передан,
  // `messages` должен заканчиваться тем самым ходом ассистента с
  // соответствующими tool_use-блоками — клиент просто досылает то же самое.
  const decisions = body.decisions && typeof body.decisions === 'object' ? body.decisions : null;
  if (!clientMessages.length) { res.status(400).json({ error: 'messages required' }); return; }

  try {
    const result = await runAssistantLoop(clientMessages, decisions, ANTHROPIC_API_KEY);
    res.status(200).json(result);
  } catch (err) {
    console.error('claude-assistant error:', err);
    res.status(500).json({ error: err.message || String(err) });
  }
};
