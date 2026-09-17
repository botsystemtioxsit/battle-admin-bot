#!/usr/bin/env bash
# Ставит ярлык "БАТТЛ Админ" в меню приложений Linux — обычный XDG
# .desktop-файл, тот же механизм, что и у любого другого установленного
# приложения. В ChromeOS (Crostini) это автоматически появляется в общем
# лаунчере среди Linux-приложений (сервис garcon следит за
# ~/.local/share/applications) — на обычном Debian/Ubuntu с рабочим столом
# (GNOME/KDE и т.п.) работает тем же способом. Запускать один раз.
#
# Работает из ЛЮБОЙ из трёх папок, куда мог попасть этот файл:
#   - рядом с battle-admin-gui.sh (запуск из исходников, см. README)
#   - рядом с распакованным battle-admin-desktop (.tar.gz — этот скрипт
#     и icon.png кладутся в архив автоматически, см. package.json →
#     build.linux.extraFiles)
#   - рядом с *.AppImage
# Скрипт сам определяет, что рядом лежит, и настраивает ярлык на это.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$DIR/battle-admin-gui.sh" ]; then
  EXEC_TARGET="$DIR/battle-admin-gui.sh"
elif [ -f "$DIR/battle-admin-desktop" ]; then
  EXEC_TARGET="$DIR/battle-admin-desktop"
  chmod +x "$EXEC_TARGET" 2>/dev/null || true
else
  APPIMAGE="$(find "$DIR" -maxdepth 1 -iname '*.AppImage' -print -quit)"
  if [ -n "$APPIMAGE" ]; then
    EXEC_TARGET="$APPIMAGE"
    chmod +x "$EXEC_TARGET" 2>/dev/null || true
  else
    echo "Не нашёл рядом ни battle-admin-gui.sh, ни battle-admin-desktop, ни *.AppImage." >&2
    echo "Запустите этот скрипт из той же папки, куда распаковали приложение." >&2
    exit 1
  fi
fi

ICON_DIR="$HOME/.local/share/icons"
APPS_DIR="$HOME/.local/share/applications"
mkdir -p "$ICON_DIR" "$APPS_DIR"
cp "$DIR/icon.png" "$ICON_DIR/battle-admin.png"

cat > "$APPS_DIR/battle-admin.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=БАТТЛ Админ
Comment=Панель администратора БАТТЛ
Exec=$EXEC_TARGET
Icon=$ICON_DIR/battle-admin.png
Terminal=false
Categories=Utility;
EOF
chmod +x "$APPS_DIR/battle-admin.desktop"

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true

echo "Готово. Иконка «БАТТЛ Админ» должна появиться в меню приложений"
echo "(в ChromeOS — в общем лаунчере среди Linux-приложений; если не видно"
echo "сразу, откройте лаунчер заново или подождите пару секунд)."
