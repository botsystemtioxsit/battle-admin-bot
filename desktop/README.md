# БАТТЛ Админ — десктоп

Окно Electron, которое открывает живую веб-панель (`public/admin.html`,
тот же адрес, что и в браузере) — без вкладок, адресной строки и
необходимости держать браузер открытым. Это не отдельная копия панели:
внутри крутится ровно та же страница, что видят все остальные, так что
любое обновление панели (push в `src/admin.html` → автосборка → GitHub
Pages/Vercel) сразу долетает и сюда, без переустановки приложения.

Вход внутри работает как обычно — email-заявка или токен доступа (см.
`screen-login` в `src/admin.html`), ничего специального для десктоп-версии
настраивать не нужно.

**Сама обёртка (иконка/разрешения/версия Electron — не содержимое панели,
то и так всегда живое) умеет обновляться сама**, через `electron-updater`:
Windows и Linux (AppImage) публикуются в один общий версионный релиз
GitHub (см. `build.publish` в `package.json` — тег `v<версия>`), и
собранное приложение при каждом запуске тихо проверяет `releases/latest`
и сама доставляет новую версию к следующему перезапуску, без похода за
файлом вручную. Реально работает только для Windows-инсталлятора и
Linux AppImage — `.deb`/`.tar.gz` как и раньше обновляются вручную,
перекачкой по той же ссылке.

## Запуск одной командой

```bash
cd desktop
./battle-admin-gui.sh
```

Скрипт сам ставит недостающие системные библиотеки Chromium (спросит
пароль sudo при первом запуске, если их нет — частая ситуация в
контейнерах вроде ChromeOS Crostini), сам делает `npm install` при первом
запуске (~100+ МБ, качается один раз), и открывает окно. Повторные запуски
— сразу окно, без лишних вопросов.

Чтобы получить прямо одну команду `battle-admin-gui` из любой папки
терминала (не обязательно, но удобно):
```bash
mkdir -p ~/.local/bin
ln -sf "$(pwd)/battle-admin-gui.sh" ~/.local/bin/battle-admin-gui
```
После этого — просто `battle-admin-gui` откуда угодно (`~/.local/bin`
обычно уже в PATH на Debian/Ubuntu и в Crostini; если команда не находится,
добавьте `export PATH="$HOME/.local/bin:$PATH"` в `~/.bashrc`).

## Иконка в меню приложений (чтобы не набирать команду каждый раз)

```bash
cd desktop
./install-launcher.sh
```

Ставит ярлык «БАТТЛ Админ» (с собственным значком, `icon.png`) в
`~/.local/share/applications` — обычный способ добавить приложение в меню
на Linux. В ChromeOS (Crostini) он сам появляется в общем лаунчере среди
Linux-приложений; на Debian/Ubuntu с рабочим столом (GNOME/KDE и т.п.) —
в меню приложений тем же образом. Запускать один раз; сама иконка потом
просто вызывает `battle-admin-gui.sh` — так что первый клик по ней тоже
может попросить пароль sudo, если системные библиотеки ещё не поставлены.

## Способы установки на Linux / ChromeOS (Crostini)

Готовые файлы всех трёх форматов ниже собираются автоматически в CI при
каждом изменении `desktop/` и публикуются одним общим релизом вместе с
Windows-сборкой (нужно для автообновления, см. выше) —
**[releases/latest](https://github.com/botsystemtioxsit/battle-admin-bot/releases/latest)**
(ссылка отдаётся самим GitHub и всегда указывает на актуальный релиз). На части
свежих образов ChromeOS Crostini `.deb`-пакеты через `dpkg` ставить больше
нельзя — тогда используйте AppImage или `.tar.gz` ниже, оба не зависят от
пакетного менеджера контейнера вообще.

1. **`.tar.gz` — самый надёжный вариант, если остальное не заводится.**
   Не ставит ничего в систему, просто распаковывается в папку. На
   ChromeOS браузер скачивает файл в «Загрузки» самого ChromeOS — это
   НЕ то же самое, что `~/Downloads` внутри Linux (Crostini): откройте
   приложение «Файлы» → «Загрузки» → правый клик по файлу → **«Copy to
   Linux»**, только после этого он появится в домашней папке контейнера.
   ```bash
   tar -xzf battle-admin-desktop-*.tar.gz
   cd battle-admin-desktop-*/
   ./battle-admin-desktop
   ```
   Если при запуске пишет `error while loading shared libraries:
   libnss3.so...` — это отдельная нехватка системных библиотек
   Chromium (сам `.tar.gz` их с собой не носит), лечится один раз:
   ```bash
   sudo apt-get update
   sudo apt-get install -y libnss3 libnspr4 libatk-bridge2.0-0 libatk1.0-0 libgtk-3-0 libgbm1 libasound2 libxss1 libxtst6 libdrm2 libxkbcommon0
   # если apt ругается на libasound2 (переименован на новых Debian/Ubuntu):
   sudo apt-get install -y libasound2t64
   ```
   Чтобы получить ярлык в меню приложений из этой же папки — тот же
   `install-launcher.sh`, что и ниже, только вместо `battle-admin-gui.sh`
   в нём нужно указать путь до `battle-admin-desktop` (одна строка
   `Exec=` в `~/.local/share/applications/battle-admin.desktop`).

2. **AppImage — тоже без установки, но нужен FUSE. Единственный Linux-формат,
   который умеет обновляться сам** (см. автообновление выше).
   ```bash
   chmod +x *.AppImage
   ./*.AppImage
   ```
   Если ругается на отсутствие FUSE (частая ситуация в свежих Debian/
   Crostini, где `libfuse2` больше не ставится по умолчанию):
   ```bash
   sudo apt-get update
   sudo apt-get install -y libfuse2 || sudo apt-get install -y libfuse2t64
   ```

3. **`.deb` — обычная установка через пакетный менеджер, если он ещё
   поддерживается на вашем образе ChromeOS:**
   ```bash
   sudo dpkg -i battle-admin-desktop_*_amd64.deb
   ```

4. **Собрать/запустить из исходников — универсальный запасной вариант,
   если ни один из готовых файлов выше не подходит.** Требует `git` и
   `node`/`npm` (в Crostini обычно уже есть или ставится одной командой
   `sudo apt-get install -y git nodejs npm`):
   ```bash
   git clone https://github.com/botsystemtioxsit/battle-admin-bot.git
   cd battle-admin-bot/desktop
   ./battle-admin-gui.sh
   ```
   Именно так собран блок «Запуск одной командой» выше — `battle-admin-gui.sh`
   сам доставит недостающие системные библиотеки Chromium и Electron.

Собрать все три файла локально вручную (то же самое, что делает CI):
```bash
cd desktop
npm install
npm run build:linux
```
Готовые файлы появятся в `desktop/dist/`.

Windows (`.exe`-установщик, NSIS) — собирается кросс-компиляцией прямо
здесь, из-под Linux, через electron-builder + wine (никакой Windows-машины
не нужно):
```bash
cd desktop
npm install
npm run build:win
```
Если `wine` не установлен, электрон-билдер сам скажет — тогда один раз:
```bash
sudo dpkg --add-architecture i386
sudo apt-get update
sudo apt-get install -y wine wine64 wine32:i386
```
Готовый `БАТТЛ Админ Setup <версия>.exe` появится в `desktop/dist/` —
обычный next-next-finish инсталлятор, ставит окно приложения плюс ярлык
в меню «Пуск» и на рабочий стол, ничего вручную донастраивать не нужно.
Это единственный Windows-формат, других не собираем — и он же умеет
обновляться сам через `electron-updater` (см. выше).

## Свой значок приложения

Сейчас используется `desktop/icon.png` (череп со звездой). Чтобы заменить на свой — положите квадратный PNG минимум
512×512 поверх `desktop/icon.png` под тем же именем, ничего больше менять
не нужно (окно, ярлык меню и сборка AppImage/.deb/.exe уже ссылаются
именно на этот файл).
