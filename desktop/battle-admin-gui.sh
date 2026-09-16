#!/usr/bin/env bash
# Один запуск — и окно панели просто открывается. Первый раз займёт
# подольше (ставит недостающие системные библиотеки Chromium и качает сам
# Electron через npm install), дальше запускается сразу.
#
# Как получить одну команду из любой папки терминала (не обязательно):
#   mkdir -p ~/.local/bin
#   ln -sf "$(pwd)/battle-admin-gui.sh" ~/.local/bin/battle-admin-gui
# После этого — просто "battle-admin-gui" откуда угодно.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Системных библиотек Chromium/Electron часто просто нет из коробки —
# особенно в минимальных контейнерах вроде ChromeOS Crostini (penguin).
# dpkg -s тихо проверяет "уже стоит?", чтобы не спрашивать пароль sudo
# заново на каждом запуске, когда всё уже поставлено один раз.
REQUIRED_LIBS="libnss3 libnspr4 libatk-bridge2.0-0 libatk1.0-0 libgtk-3-0 libgbm1 libasound2 libxss1 libxtst6 libdrm2 libxkbcommon0"
MISSING=""
for pkg in $REQUIRED_LIBS; do
  dpkg -s "$pkg" >/dev/null 2>&1 || MISSING="$MISSING $pkg"
done
if [ -n "$MISSING" ]; then
  echo "Ставлю недостающие системные библиотеки:$MISSING"
  sudo apt-get update -qq
  # На новых Debian/Ubuntu libasound2 переименован в libasound2t64 — если
  # обычное имя не нашлось, пробуем ещё раз с заменой именно этого пакета,
  # а не падаем со всей установкой из-за одного переименования.
  if ! sudo apt-get install -y $MISSING; then
    ALT="$(echo "$MISSING" | sed 's/libasound2\b/libasound2t64/')"
    sudo apt-get install -y $ALT
  fi
fi

if [ ! -d node_modules/electron ]; then
  echo "Первый запуск — устанавливаю зависимости (Electron, ~100+ МБ)…"
  npm install
fi

exec npm start
