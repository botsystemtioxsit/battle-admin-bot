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
каждом изменении `desktop/` и публикуются одним и тем же релизом —
**[desktop-linux-latest](https://github.com/botsystemtioxsit/battle-admin-bot/releases/tag/desktop-linux-latest)**
(ссылка не меняется между сборками, всегда актуальная версия). На части
свежих образов ChromeOS Crostini `.deb`-пакеты через `dpkg` ставить больше
нельзя — тогда используйте AppImage или `.tar.gz` ниже, оба не зависят от
пакетного менеджера контейнера вообще.

1. **`.tar.gz` — самый надёжный вариант, если остальное не заводится.**
   Не ставит ничего в систему, просто распаковывается в папку:
   ```bash
   tar -xzf battle-admin-desktop-*.tar.gz
   cd battle-admin-desktop-*/
   ./battle-admin-desktop
   ```
   Чтобы получить ярлык в меню приложений из этой же папки — тот же
   `install-launcher.sh`, что и ниже, только вместо `battle-admin-gui.sh`
   в нём нужно указать путь до `battle-admin-desktop` (одна строка
   `Exec=` в `~/.local/share/applications/battle-admin.desktop`).

2. **AppImage — тоже без установки, но нужен FUSE.**
   ```bash
   chmod +x "БАТТЛ Админ-1.0.0.AppImage"
   ./"БАТТЛ Админ-1.0.0.AppImage"
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
   sudo dpkg -i battle-admin-desktop_1.0.0_amd64.deb
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
Готовый `БАТТЛ Админ Setup 1.0.0.exe` появится в `desktop/dist/` —
обычный next-next-finish инсталлятор, ставит окно приложения плюс ярлык
в меню «Пуск» и на рабочий стол, ничего вручную донастраивать не нужно.

## Свой значок приложения

Сейчас используется `desktop/icon.png` (простой золотой медальон с «Б» —
заготовка). Чтобы заменить на свой — положите квадратный PNG минимум
512×512 поверх `desktop/icon.png` под тем же именем, ничего больше менять
не нужно (окно, ярлык меню и сборка AppImage/.deb/.exe уже ссылаются
именно на этот файл).
