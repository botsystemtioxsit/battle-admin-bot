# Бот на Telegram Serverless

Третий способ запустить бота, помимо `bot/index.js` (long polling) и
`api/telegram-webhook.js` (Vercel). Здесь не нужны ни сервер, ни Vercel, ни
`setWebhook`, ни `WEBHOOK_SECRET`: апдейты приходят прямо от Telegram.

Бот — игровой @troll_battle_bot, им пользуются игроки. `/start` присылает
кнопку игры, `/admin` — кнопку админ-панели (роль проверяет сама страница),
`/help` — справку. Редактор BotFather ломает переносы строк при вставке с
телефона (Save failed), поэтому туда вставляется этот код одной строкой.

## Установка через BotFather (без CLI)

1. @BotFather → бот → **Serverless** → включить (уже включено).
2. **Handlers** → создать handler для типа **message** и вставить туда
   содержимое `handlers/message.js`.
3. Отправить боту `/start` и проверить, что пришла кнопка.
4. **Отключить старый вариант**: остановить `bot/index.js` (Railway/systemd).
   Вебхук Vercel BotFather перепишет сам, а проект на Vercel можно оставить
   как запасной для `admin.html`.

## Через CLI

Токен лежит в BotFather → Serverless → CLI Access → Access token. Он
отдельный от токена бота.

```bash
cd telegram-serverless
npx tgcloud login   # спросит CLI access token
npx tgcloud push
```

## Чего здесь нет

Список команд (`setMyCommands`) и кнопку меню (`setChatMenuButton`) раньше
выставлял при старте `bot/index.js`. Обе настройки хранятся на стороне
Telegram, поэтому после остановки бота они никуда не денутся. Если их нужно
поменять, это делается в BotFather: Edit Commands и Menu Button.

## Уведомление о запросе на вход

`/requests` — ручной способ. Автоматически бот пишет сам: игра и админка
сразу после создания заявки вызывают `role-gateway` → `POST /login-notify`
(Cloudflare Worker, у него есть `BOT_TOKEN`). Worker проверяет, что заявка
реально есть, `pending` и свежая, помечает её `notifiedAt` (одно
уведомление на заявку) и шлёт сообщение с кнопками. Нажатия кнопок
обрабатывает `handlers/callback_query.js`. В самом Serverless исходящих
запросов это не требует, а Endpoints для этого не годятся: их можно
вызвать только из Mini App внутри Telegram, а запрос на вход приходит из
обычного браузера.
