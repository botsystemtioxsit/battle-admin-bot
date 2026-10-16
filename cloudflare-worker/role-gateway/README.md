# role-gateway — Cloudflare Worker

Закрывает дыру: раньше `admin.html` сам проверял, можно ли выдать роль
admin/superadmin, используя секретный ключ, зашитый в его собственном JS —
а это видно в DevTools у любого, кто откроет страницу. Теперь проверку
делает этот Worker: он выполняется на сервере Cloudflare, его код никогда
не попадает в браузер, и только он знает секреты.

## Что он делает

`POST /grant-role` и `POST /set-status` — тело `{ initData, targetUserId,
newRole }` / `{ initData, targetUserId, newStatus, restrictedUntil }`, но
`initData` можно заменить на `{ telegramId, deviceId }` (см. «Доверенные
устройства» ниже — то же доверенное устройство, что и у бэкапов):
1. Проверяет подпись `initData` (её даёт `Telegram.WebApp.initData` внутри
   мини-приложения) через `BOT_TOKEN` — подделать её без токена бота
   невозможно — либо, если initData нет, подписанную запись
   `users/$uid/trustedDevices/sha256($deviceId)`.
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
Mini App).

### Доверенные устройства (`{ telegramId, deviceId }`)

База читается и пишется всеми (`database.rules.json`), поэтому в ней
нельзя хранить то, что одновременно служит доказательством личности.
`deviceId` (128 бит случайности, `localStorage.battleDeviceId`) остаётся
**только в браузере** и приходит сюда только в теле HTTPS-запроса. В базе
лежит `deviceKey = sha256(deviceId)`:

- запись `users/$uid/trustedDevices/$deviceKey` считается доверием, только
  если несёт `sig = HMAC(ключ из BOT_TOKEN, uid|deviceKey|expiresAt)`;
- создаёт такую запись только Worker — `POST /trust-device`
  (`{ initData | telegramId+deviceId, targetUserId, deviceKey, label,
  durationMs }`): либо владелец аккаунта (moderator/admin/superadmin)
  одобряет своё устройство, личность подтверждена initData или уже
  доверенным устройством (парный код «Подключить по коду», первый вход
  суперадмина из Telegram), либо superadmin одобряет устройство другого
  человека («Запросы на устройства»);
- подделать запись прямой записью в открытую базу нельзя — без секрета
  подпись не получить; срок (`expiresAt`) входит в подпись, так что его
  тоже не продлить; запись другого аккаунта, скопированная на этот, не
  проходит (в подписи `uid`).

Записи старого формата (ключ — сырой `deviceId`, без `sig`) не принимаются:
они были публично читаемы (по ним любой мог пройти проверку), поэтому
устройства нужно одобрить заново. Новых секретов настраивать не нужно —
ключ подписи выводится из `BOT_TOKEN`; смена `BOT_TOKEN` аннулирует все
доверенные устройства.

**Порядок выкладки:** сначала `npx wrangler deploy` (Worker), потом
публикация нового `admin.html` — иначе новая панель будет вызывать ещё не
существующий `/trust-device`.

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

## Выкладка без терминала (GitHub Actions)

`.github/workflows/deploy-role-gateway.yml` запускается сам при слиянии
изменений `cloudflare-worker/role-gateway/**` в `main` (или кнопкой **Run
workflow** на вкладке Actions репозитория `battle-admin-bot`) и делает всё за вас:
1. самотест — ключ сервисного аккаунта реально пишет в базу в обход правил
   (иначе выкладка останавливается ДО того, как что-то сломается);
2. `wrangler deploy`;
3. кладёт ключ сервисного аккаунта Worker'у как секрет
   `FIREBASE_SERVICE_ACCOUNT` — берёт его из уже существующего секрета
   GitHub с тем же именем (тот самый, которым `index.html` выкладывает
   правила), руками копировать JSON не нужно;
4. проверяет `/health`: должно быть `firebaseAdminConfigured: true`.

Разовая настройка — секрет репозитория `CLOUDFLARE_API_TOKEN` (токен
Cloudflare по шаблону «Edit Cloudflare Workers»; `CLOUDFLARE_ACCOUNT_ID`
нужен, только если токен видит несколько аккаунтов). Остальные секреты
Worker'а (`BOT_TOKEN`, `GITHUB_TOKEN`) переживают выкладку.

**Порядок выкладки всего пакета:** 1) этот Worker (работает и со старыми, и с
новыми правилами) → 2) панель (`main` → сборка `public/admin.html`) →
3) `database.rules.json` в репозитории `index.html` (уходит в Firebase сам
при пуше в `main`; не пускает клиентов писать `admin`/`superadmin`, чужие
`status/points/starsBalance` owner-аккаунтов и `trustedDevices`). Правила
раньше Worker'а выкладывать нельзя — выдача ролей и бан перестанут
работать. Откат: вернуть прежние правила и убрать секрет
`FIREBASE_SERVICE_ACCOUNT` (Worker вернётся в legacy-режим).

Ключ сервисного аккаунта даёт полный доступ к базе, поэтому живёт только
в секретах (GitHub и Worker) и не должен попадать в логи или код. Чем уже его
роли в Google Cloud, тем лучше: для работы нужна «Firebase Realtime Database
Admin» (самотест скажет, если её не хватает).

## Известные ограничения (требуют решения владельца)

- **`ROLE_GRANT_KEY` на мгновение лежал в открытой базе (исправлено кодом, ждёт выкладки).**
  `.validate` в `database.rules.json` умеет только сравнивать данные с литералом, поэтому
  Worker клал ключ в саму запись (`roleGrantKey`/`adminActionKey`) и стирал
  отдельным запросом. База читается всеми — любой подключённый слушатель
  видел этот промежуточный коммит (при выдаче роли, бане, каждом завершённом
  бое, восстановлении базы). Теперь Worker пишет токеном сервисного аккаунта
  (`FIREBASE_SERVICE_ACCOUNT`, admin-режим): такой запрос идёт в обход правил,
  и никакой секрет в данные не попадает. Пока секрет не задан, Worker работает
  по-старому (legacy) — `/health` показывает `firebaseAdminConfigured`. Ключ
  `ROLE_GRANT_KEY`, пока он использовался, следует считать скомпрометированным.
- **Права берутся из полей, которые вызывающий может сам записать**
  (`role: 'moderator'` пишется без ключа, `permissions/backups` — любой
  булевой). Поэтому `/set-status` и бэкап-эндпоинты (включая
  `/restore-code`) доступны любому, у кого есть настоящая `initData`.
- Отзыв устройства нельзя сделать «липким»: подписанная запись публична
  и может быть записана обратно её владельцем.

## Обновление кода Worker'а

```bash
cd cloudflare-worker/role-gateway
npx wrangler deploy
```

Секреты (`wrangler secret put`) трогать заново не нужно — они хранятся в
Cloudflare отдельно от кода и переживают деплои.
