# role-gateway — Cloudflare Worker

Закрывает дыру: раньше `admin.html` сам проверял, можно ли выдать роль
admin/superadmin, используя секретный ключ, зашитый в его собственном JS —
а это видно в DevTools у любого, кто откроет страницу. Теперь проверку
делает этот Worker: он выполняется на сервере Cloudflare, его код никогда
не попадает в браузер, и только он знает секреты.

## Что он делает

`POST /grant-role` с телом `{ initData, targetUserId, newRole }`:
1. Проверяет подпись `initData` (её даёт `Telegram.WebApp.initData` внутри
   мини-приложения) через `BOT_TOKEN` — подделать её без токена бота
   невозможно.
2. Смотрит текущую роль подписавшегося в Firebase — должна быть
   `superadmin`.
3. Если всё сошлось — пишет `role` + `roleGrantKey` в Firebase (ключ нужен
   только чтобы пройти `database.rules.json`, сразу стирается).

## Разовая настройка (сделать один раз)

Требуется Node.js. `wrangler` ставить отдельно не нужно — `npx` подтянет
сам при первом запуске.

```bash
cd cloudflare-worker/role-gateway
npx wrangler login          # откроет браузер, авторизует Cloudflare-аккаунт
npx wrangler secret put BOT_TOKEN         # вставить токен бота от @BotFather
npx wrangler secret put ROLE_GRANT_KEY    # вставить значение из чата с Claude / см. ниже
npx wrangler deploy
```

После `deploy` в терминале появится адрес вида
`https://battle-role-gateway.<твой-поддомен>.workers.dev` — его нужно
вписать в `src/admin.html` (переменная `ROLE_GATEWAY_URL`, см. коммент
рядом с ней).

**`ROLE_GRANT_KEY` — НИКОГДА не коммитить в этот файл или куда-либо ещё
в репозитории** (он публичный) — значение существует только в двух
местах: здесь через `wrangler secret put` (хранится в Cloudflare, не в
git) и как GitHub Actions secret `ROLE_GRANT_KEY` в репозитории
`index.html` (Settings → Secrets and variables → Actions) — оттуда
`firebase-database-deploy.yml` подставляет его в `database.rules.json`
только в момент деплоя, сам файл в git всегда содержит только
плейсхолдер `__ROLE_GRANT_KEY__`. Значения в обоих местах должны
совпадать один в один — при смене меняешь сразу оба, иначе выдача роли
перестанет работать у всех.

## Обновление кода Worker'а

```bash
cd cloudflare-worker/role-gateway
npx wrangler deploy
```

Секреты (`wrangler secret put`) трогать заново не нужно — они хранятся в
Cloudflare отдельно от кода и переживают деплои.
