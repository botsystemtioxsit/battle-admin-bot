// Обработчик сообщений для Telegram Serverless (@BotFather → бот → Serverless
// → Handlers → message). Бот — игровой @troll_battle_bot, им пользуются
// игроки: /start открывает игру, /admin — админ-панель (доступ к ней
// проверяет сама страница по роли в базе), /help — справка. Остальные
// сообщения игнорируются.
//
// Редактор BotFather при вставке с телефона ломает переносы строк (Save
// failed), поэтому туда вставляется однострочная версия этого же кода.
import { api } from 'sdk';

const GAME_URL = 'https://botsystemtioxsit.github.io/index.html/';
const ADMIN_URL = 'https://botsystemtioxsit.github.io/battle-admin-bot/public/admin.html';

// Telegram агрессивно кэширует Mini App по точному URL
function withCacheBust(url) {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}v=${Date.now()}`;
}

export default async function (message, ctx) {
  const command = (message.text || '').trim().split(' ')[0].split('@')[0];
  if (command === '/start') {
    await api.sendMessage({
      chat_id: message.chat.id,
      text: 'Тролль-Баттл: жми кнопку, чтобы играть.',
      reply_markup: { inline_keyboard: [[{ text: 'Играть', web_app: { url: withCacheBust(GAME_URL) } }]] }
    });
  } else if (command === '/admin') {
    await api.sendMessage({
      chat_id: message.chat.id,
      text: 'Админ-панель. Доступ проверяется по твоей роли в базе.',
      reply_markup: { inline_keyboard: [[{ text: 'Открыть админ-панель', web_app: { url: withCacheBust(ADMIN_URL) } }]] }
    });
  } else if (command === '/help') {
    await api.sendMessage({
      chat_id: message.chat.id,
      text: '/start - играть\n/admin - админ-панель (только для модераторов и админов)'
    });
  }
}
