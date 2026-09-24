# role-gateway — Cloudflare Worker

Закрывает дыру: раньше `admin.html` сам проверял, можно ли выдать роль
admin/superadmin, используя секретный ключ, зашитый в его собственном JS —
а это видно в DevTools у любого, кто откроет страницу. Теперь проверку
делает этот Worker: он выполняется на сервере Cloudflare, его код никогда
не попадает в браузер, и только он знает секреты.

## Что он делает

`POST /grant-role` и `POST /set-status` — тело `{ initData, targetUserId,
newRole }` / `{ initData, targetUserId, newStatus, restrictedUntil }`, но
`initData` можно заменить на `{ telegramId, deviceId }` (см. `verifyIdentity`
ниже — то же доверенное устройство, что и у бэкапов):
1. Проверяет подпись `initData` (её даёт `Telegram.WebApp.initData` внутри
   мини-приложения) через `BOT_TOKEN` — подделать её без токена бота
   невозможно — либо, если initData нет, `deviceId` по
   `users/$uid/trustedDevices/$deviceId`.
2. Смотрит текущую роль подписавшегося в Firebase — для `/grant-role`
   должна быть `superadmin`, для `/set-status` — любая из
   moderator/admin/superadmin.
3. Если всё сошлось — пишет `role`/`status` + служебный ключ
   (`roleGrantKey`/`adminActionKey`) в Firebase, нужный только чтобы пройти
   `database.rules.json`, сразу стирается.

`POST /backup-now` (`{ initData }`), `POST /restore-code` (`{ initData,
repo, files }` — `repo` — `index.html`/`battle-admin-bot`, `files` —
`[{ path, base64 }]` из распакованного архива снимка), `POST /list-backups`
(`{ initData }`, отдаёт `{ codeIndex, codeAdmin, db }` — имя+размер каждого
снимка), `POST /download-backup` и `POST /delete-backup` (оба — `{
initData, path }`, path — `code-backups/<repo>/<файл>.zip` или
`db-snapshots/<файл>.json`; download отдаёт сырые байты файла, delete
удаляет его из репозитория навсегда): проверка `initData` +
`hasBackupsAccess` (superadmin или `users/$uid/permissions/backups ===
true` — то же делегируемое право, что admin.html уже проверяет на
клиенте), сам вызов GitHub API идёт с `GITHUB_TOKEN` этого Worker'а.
`battle-data-admin-bot` — приватный репозиторий, так что и листинг, и
скачивание снимков требуют авторизации;
раньше это делалось PAT, вставленным прямо в браузер оператора
(`localStorage`) в обеих панелях (`battle-data-admin-bot/public/index.html`
и `battle-admin-bot/src/admin.html`) — токен был виден через DevTools
любому, кто физически сидит за тем же компьютером. Теперь его знает
только этот Worker, а обе панели ходят через него.

`/restore-database` — исключение из `hasBackupsAccess`: остаётся строго
`superadmin`-only (полная перезапись базы — самое разрушительное действие
из всех, сознательно не делегируется).

Все шесть бэкап-эндпоинтов (`/backup-now`, `/restore-code`,
`/restore-database`, `/list-backups`, `/download-backup`, `/delete-backup`)
и, отдельно, `/grant-role`/`/set-status` принимают `initData` ИЛИ
`{ telegramId, deviceId }` — второе нужно, чтобы все эти действия работали
не только внутри настоящей Telegram-сессии, но и из desktop-приложения/
обычного браузера (initData там физически недоступна — это не Telegram
Mini App). `deviceId` проверяется по `users/$uid/trustedDevices/$deviceId`
— тому же 128-битному случайному токену, что уже обязателен для самого
входа в admin.html под admin/superadmin (см. код рядом с
`protectedRoles`) — так что desktop/браузер, уже прошедшие этот вход, не
теряют доступ к выдаче ролей/бану/бэкапам только из-за того, что это не
настоящий Telegram Mini App.

`restoreCode` кладёт текстовые файлы прямо в дерево коммита (Git Trees API
принимает `content` вместо `sha` и создаёт блоб сам) — отдельный
`POST /git/blobs` теперь нужен только бинарным файлам. Это не косметика:
Cloudflare Worker ограничивает число исходящих запросов за один вызов, и
при одном blob-запросе на файл восстановление большого репозитория
(полсотни+ файлов) падало с "Too many subrequests by single Worker
invocation" ещё до того, как вообще пытался собраться коммит.

## Разовая настройка (сделать один раз)

Требуется Node.js. `wrangler` ставить отдельно не нужно — `npx` подтянет
сам при первом запуске.

```bash
cd cloudflare-worker/role-gateway
npx wrangler login          # откроет браузер, авторизует Cloudflare-аккаунт
npx wrangler secret put BOT_TOKEN         # вставить токен бота от @BotFather
npx wrangler secret put ROLE_GRANT_KEY    # вставить значение из чата с Claude / см. ниже
npx wrangler secret put GITHUB_TOKEN      # fine-grained PAT, см. ниже
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

**`GITHUB_TOKEN`** — fine-grained Personal Access Token
(github.com → Settings → Developer settings → Fine-grained tokens),
выданный только на три репозитория: `battle-data-admin-bot` (Actions: Read
and write), `index.html` и `battle-admin-bot` (оба — Contents: Read and
write). Никогда не расширяй его scope на "все репозитории".

## Обновление кода Worker'а

```bash
cd cloudflare-worker/role-gateway
npx wrangler deploy
```

Секреты (`wrangler secret put`) трогать заново не нужно — они хранятся в
Cloudflare отдельно от кода и переживают деплои.
