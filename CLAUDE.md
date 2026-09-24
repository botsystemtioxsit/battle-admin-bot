# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Telegram bot + Mini App admin panel for "Тролль-Баттл" (repo `index.html`, the game itself). It talks to the **same Firebase Realtime Database** (`zolotaya-kletka`) as the game — there is no separate backend or database for the bot. The panel (`public/admin.html`, ~2200 lines: one `<style>`, HTML, one big inline `<script>`) is itself framework-free, build-free static HTML, same as the game.

Two independent ways to run the *bot* half exist in this repo — pick one, don't run both against the same `BOT_TOKEN`:
- `bot/index.js` — long polling, needs a permanently-running process (systemd unit in `deploy/battle-admin-bot.service`, or Railway via `railway.json`).
- `api/telegram-webhook.js` + `api/_lib/telegram.js` — serverless webhook (Vercel), no persistent process.

Either way, the bot itself decides nothing about access — it only sends a button that opens `public/admin.html` as a Telegram Web App. All access control happens inside `admin.html` itself.

## Commands

No build/lint/test scripts beyond `npm start` (runs `bot/index.js`). `npm install` is only needed for the bot process itself — `public/admin.html` has no dependencies to install, it loads Firebase/Telegram SDKs from CDN `<script src>` tags.

Validating a change to `admin.html` (no test suite exists — this is the de facto check):
```bash
node -e "
const fs = require('fs');
const html = fs.readFileSync('public/admin.html', 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
scripts.forEach((s,i) => { try { new Function(s); } catch(e) { console.log('Script', i, 'error:', e.message); } });
const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
console.log('div open/close:', (noComments.match(/<div/g)||[]).length, (noComments.match(/<\/div>/g)||[]).length);
"
```
For visual changes, use Playwright with a stubbed `window.firebase`/`window.Telegram` (see the sibling `index.html` repo's CLAUDE.md — same technique applies here) and screenshot at both a desktop viewport and a narrow mobile one, since `admin.html` has its own `@media (min-width: 900px)` desktop layout.

## Architecture

### Access control (`admin.html`)
On load it takes `Telegram.WebApp.initDataUnsafe.user.id`, reads `users/<id>/role` from the shared RTDB, and shows "Доступ запрещён" unless the role is `moderator`, `admin`, or `superadmin`. Beyond that gate, **fine-grained permissions** (not fixed role tiers) decide what a given `admin` can actually do — `canManageEvent()`/`canManageClans()`/`canManageBeta()` check per-admin toggles (`users/<uid>/permissions/*`), while `canManageRoles()` is hardcoded to `role === 'superadmin'` (granting/revoking roles, and the raw database browser, are never delegable). `applyRoleUI()` hides tabs a user can't use entirely, rather than showing them disabled; the tab-content functions also self-check the same permission (e.g. `if (!canManageClans()) return;`) in case a click reaches them anyway.

### Tabs (`.tabs` / `.subview[data-panel=...]`, wired in one shared click dispatcher)
Панель / Аккаунт / Ивент / Журнал / Ошибки / Кланы / Заявки / **База** / Система (`data-tab` values: panel/account/event/logs/errors/clans/beta/database/danger). The dispatcher also does cross-cutting cleanup on every tab switch (e.g. detaching the "База" tab's live Firebase listeners when navigating away — see below) — a new tab that needs teardown-on-leave should hook in there, not add its own listener.

- **"Ошибки"** reads `admin-logs/error-reports.json` from the **`index.html` repo** (not this one) — see that repo's CLAUDE.md for why (this sandbox has no direct Firebase network access; a GitHub Actions workflow bridges it).
- **"База"** (superadmin-only) is a generic, schema-agnostic Firebase RTDB tree browser: the root key list comes from one cheap REST call (`?shallow=true`, avoids pulling the whole DB just to show folder names); expanding a top-level branch attaches a real `db.ref(topKey).on('value', ...)` listener (children below that are rendered from the already-fetched snapshot, no extra reads) and diffs old vs. new snapshots (`dbDeepEqual`/`dbCollectChanges`) to briefly flash (`.flash` / `dbFlash` keyframes) exactly the rows that changed, bubbled up to their visible ancestors. Collapsing a branch calls `.off('value', ...)` — don't leave these attached, that's the whole point of the lazy design.
- **"Система"** (README/some comments still call it "Правила платформы", an older name — code and UI say "Система") is visible to anyone with panel access but self-checks `superadmin` live on every open (`openDangerZone`), not once at login — a demoted admin loses access immediately even if the tab was already open. Gated further by a one-time secret (`config/resetSecret`) that's erased from the database after a successful reset.

### Desktop layout — same pattern as `index.html`, reimplemented independently
`admin.html` predates and does **not share code** with the game's desktop layout, but converged on an equivalent design: `.tabs` becomes a left sidebar column and `#screen-app` becomes a CSS grid (`@media (min-width: 900px)`) rather than a wrapping-flex tab row. This was built separately from the game's `.dock-desktop`/`dockOverlayToDevice` overlay-docking system — don't assume shared JS between the two repos beyond the RTDB schema and `emailLogins`.

### "Аккаунт" — cross-device login without Telegram
**No Firebase Auth, no email sent, ever** — this project must stay on Firebase's free plan, and Firebase Auth's own daily email quota was trivial to exhaust just by testing (this whole mechanism replaced an earlier Firebase Email Link implementation for exactly that reason; don't reintroduce it, and don't propose Blaze/billing as a fix for a Firebase quota). Login is a manual approval flow shared with the game (`index.html`, same CLAUDE.md section there has the full design):
- Attaching an email (Telegram session only, form hidden otherwise) writes `emailLogins/<emailToKey(email)> = telegramId` + `users/<telegramId>/attachedEmail` — refuses if that email already maps to a *different* telegramId, otherwise doesn't verify ownership at all (deliberate; the real gate is the approval tap, not the email).
- `screen-login` (shown when not opened via Telegram) takes an email, looks it up in `emailLogins`, and pushes a request to `users/<foundTelegramId>/loginRequests/<pushId>`, then listens on that exact node (5-minute timeout).
- Approving can happen from **either app**: the game's Community → Запросы tab, or right here in this panel's Account tab (`loadAccountLoginRequests`) — both just flip the same request's `status` to `approved`/`denied`. Once approved, the requesting browser saves `telegramId` to `localStorage.battleTelegramId` and calls `loadAccountAndShowApp` directly.

### Security model (read before "fixing" permission checks)
`database.rules.json` (lives in the `index.html` repo, deploys to the same project) is `.read: true, .write: true` at root, with only two `.validate` rules (a role-enum check, and `battles/$code` requiring `hostId`). There is **no real authorization boundary at the database level** — every permission check described above (role gates, `canManageX()`, the superadmin-only tabs) is a UI convenience, not a security control; anyone with the database URL and browser devtools can bypass all of it directly. This is a deliberate, accepted tradeoff for this project's scale, not an oversight — don't "fix" it by quietly tightening rules without being asked, since `role` itself was intentionally loosened (see README § "Важная оговорка по безопасности") to let the panel grant roles at all.

### Versioning
`#admin-version` in the topbar (a version string + a `title` tooltip summarizing the latest change) is the only version indicator — bump it on every change to this file, the same discipline `index.html` applies to its own `.version-block`.
