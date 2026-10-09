// Нажатия на кнопки «Разрешить»/«Отклонить» из /requests (см. message.js).
// Пишет status в users/<id>/loginRequests/<key> через REST (правила базы
// открыты на запись) — дальше всё как при подтверждении из игры: ждущий
// браузер видит approved/denied и входит или показывает отказ.
// <id> берётся из query.from.id, а не из callback_data, поэтому нажать
// можно только на свои собственные запросы.
// В BotFather вставляется одной строкой (см. message.js, почему).
import { api, fetch } from 'sdk';

const DB_URL = 'https://zolotaya-kletka-default-rtdb.firebaseio.com';

export default async function (query, ctx) {
  const data = query.data || '';
  const action = data.slice(0, 3);
  const key = data.slice(3);
  if ((action !== 'la:' && action !== 'ld:') || !/^[A-Za-z0-9_-]+$/.test(key)) {
    await api.answerCallbackQuery({ callback_query_id: query.id });
    return;
  }
  const url = DB_URL + '/users/' + query.from.id + '/loginRequests/' + key + '.json';
  const current = await (await fetch(url)).json();
  let text;
  if (!current || current.status !== 'pending') {
    text = 'Запрос уже обработан или устарел.';
  } else {
    const status = action === 'la:' ? 'approved' : 'denied';
    await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: status }) });
    text = status === 'approved' ? 'Вход разрешён.' : 'Вход отклонён.';
  }
  await api.answerCallbackQuery({ callback_query_id: query.id, text: text });
  if (query.message) {
    await api.editMessageText({ chat_id: query.message.chat.id, message_id: query.message.message_id, text: text });
  }
}
