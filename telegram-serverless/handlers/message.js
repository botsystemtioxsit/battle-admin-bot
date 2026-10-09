// Третий (и самый простой) способ запустить бота — Telegram Serverless
// (@BotFather → бот → Serverless). Логика та же, что в bot/index.js и
// api/telegram-webhook.js: бот ничего не решает про доступ, только выдаёт
// кнопку, открывающую admin.html как Mini App. Роль проверяет сама страница.
//
// Вебхук, BOT_TOKEN и WEBHOOK_SECRET здесь не нужны — апдейты приходят от
// самого Telegram, а BotFather держит вебхук в синхроне с handlers/.
// Не запускай одновременно с bot/index.js (long polling) на том же боте.
import { api } from 'sdk';

// Публичный адрес, не секрет — тот же, что открывает GitHub Pages
const MINI_APP_URL = 'https://botsystemtioxsit.github.io/battle-admin-bot/public/admin.html';

const HELP_TEXT =
  'Этот бот — вход в Mini App админ-панель проекта БАТТЛ.\n\n' +
  '/admin — открыть панель\n\n' +
  'Панель видна только тем, у кого в базе выставлена роль moderator/admin/superadmin ' +
  '(выдаётся вручную через Firebase Console — так же, как и на самом сайте).';

function withCacheBust(url) {
  // Telegram агрессивно кэширует Mini App по точному URL — без меняющегося
  // параметра кнопка продолжала бы открывать старую версию страницы
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}v=${Date.now()}`;
}

export default async function (input) {
  // по документации сюда приходит сам message; на случай, если платформа
  // передаст целый update — достаём message из него
  const msg = input && input.message ? input.message : input;
  if (!msg || typeof msg.text !== 'string' || !msg.chat) return;

  const chatId = msg.chat.id;
  // /start@ИмяБота — Telegram иногда дописывает юзернейм бота к команде
  const command = msg.text.trim().split(/\s+/)[0].split('@')[0];

  if (command === '/start' || command === '/admin') {
    await api.sendMessage({
      chat_id: chatId,
      text: 'Открой панель управления БАТТЛ. Доступ проверяется по твоей роли в базе — если её ещё не выдали, страница сама покажет «доступ запрещён».',
      reply_markup: {
        inline_keyboard: [[
          { text: '🛠 Открыть админ-панель', web_app: { url: withCacheBust(MINI_APP_URL) } }
        ]]
      }
    });
  } else if (command === '/help') {
    await api.sendMessage({ chat_id: chatId, text: HELP_TEXT });
  }
}
