// Обработчик сообщений для Telegram Serverless (@BotFather → бот → Serverless
// → Handlers → message). Бот — игровой @troll_battle_bot, им пользуются
// игроки: /start открывает игру, /admin — админ-панель (доступ к ней
// проверяет сама страница по роли в базе), /requests — ожидающие запросы
// на вход с другого устройства (users/<id>/loginRequests, тот же поток, что
// Сообщество → Запросы в игре) с кнопками, которые обрабатывает
// callback_query.js. Остальные сообщения игнорируются.
//
// Редактор BotFather при вставке с телефона ломает переносы строк (Save
// failed), поэтому туда вставляется однострочная версия этого же кода
// (внутри функций нет //-комментариев, чтобы строки можно было склеить).
import { api, fetch } from 'sdk';

const GAME_URL = 'https://botsystemtioxsit.github.io/index.html/';
const ADMIN_URL = 'https://botsystemtioxsit.github.io/battle-admin-bot/public/admin.html';
const DB_URL = 'https://zolotaya-kletka-default-rtdb.firebaseio.com';

export default async function (message, ctx) {
  const chatId = message.chat.id;
  const command = (message.text || '').trim().split(' ')[0].split('@')[0];
  const v = '?v=' + Date.now();
  if (command === '/start') {
    await api.sendMessage({
      chat_id: chatId,
      text: 'Тролль-Баттл: жми кнопку, чтобы играть.',
      reply_markup: { inline_keyboard: [[{ text: 'Играть', web_app: { url: GAME_URL + v } }]] }
    });
  } else if (command === '/admin') {
    await api.sendMessage({
      chat_id: chatId,
      text: 'Админ-панель. Доступ проверяется по твоей роли в базе.',
      reply_markup: { inline_keyboard: [[{ text: 'Открыть админ-панель', web_app: { url: ADMIN_URL + v } }]] }
    });
  } else if (command === '/requests' && message.chat.type === 'private') {
    try {
      const res = await fetch(DB_URL + '/users/' + message.from.id + '/loginRequests.json');
      const all = (await res.json()) || {};
      const pending = Object.keys(all).filter((k) => all[k] && all[k].status === 'pending' && Date.now() - (all[k].requestedAt || 0) < 5 * 60 * 1000);
      if (pending.length === 0) {
        await api.sendMessage({ chat_id: chatId, text: 'Нет ожидающих запросов на вход.' });
        return;
      }
      for (const k of pending) {
        const r = all[k];
        const mins = Math.round((Date.now() - r.requestedAt) / 60000);
        await api.sendMessage({
          chat_id: chatId,
          text: 'Запрос на вход в твой аккаунт: ' + (r.device || 'неизвестное устройство') + ', ' + mins + ' мин. назад. Если это не ты - отклони.',
          reply_markup: { inline_keyboard: [[{ text: 'Разрешить', callback_data: 'la:' + k }, { text: 'Отклонить', callback_data: 'ld:' + k }]] }
        });
      }
    } catch (e) {
      await api.sendMessage({ chat_id: chatId, text: 'Ошибка /requests: ' + (e && e.message ? e.message : String(e)) });
    }
  } else if (command === '/help') {
    await api.sendMessage({
      chat_id: chatId,
      text: '/start - играть\n/requests - запросы на вход с другого устройства\n/admin - админ-панель'
    });
  }
}
