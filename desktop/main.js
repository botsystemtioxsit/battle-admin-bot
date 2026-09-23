// Десктоп-обёртка над той же самой веб-панелью — не отдельное приложение
// со своим кодом UI, а окно Electron, которое открывает ЖИВУЮ страницу
// панели (тот же адрес, что и в обычном браузере). Так апдейт панели
// (push в src/admin.html -> автосборка -> GitHub Pages/Vercel) сразу
// долетает и сюда, без пересборки и переустановки десктоп-приложения —
// то же самое, что уже происходит в браузере у всех остальных.
const { app, BrowserWindow, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

// URL, который видно в адресной строке браузера при открытии панели не из
// Telegram — тот же самый, просто в отдельном окне без браузерных вкладок/
// адресной строки. Вход внутри работает как обычно (email-заявка или
// токен доступа — см. screen-login в src/admin.html), никакой отдельной
// авторизации для самого приложения не требуется.
const ADMIN_URL = 'https://botsystemtioxsit.github.io/battle-admin-bot/public/admin.html';

// Три формата сборки под Linux (AppImage/.deb/.tar.gz, см. package.json →
// build.linux.target) — один и тот же код, просто по-разному упакован, и
// самообновление (см. ниже) реально работает только у AppImage. Человеку
// со стороны это не видно вообще никак — отсюда и путаница на практике
// (спросили "что я вообще поставил?").
//
// Сначала это было в заголовке окна — оказалось ненадёжно: на ChromeOS
// (Crostini) заголовок Linux-окна либо обрезается краем экрана, либо
// вообще не показывается в развёрнутом состоянии, и разглядеть его можно
// только через подсказку в шелфе. Поэтому метку дублируем туда, где её
// увидят гарантированно — прямо в самой панели, рядом с "v4.5" — но НЕ
// правкой src/admin.html (та строка общая для браузера/Android/десктопа
// и не должна знать про упаковку конкретно этого клиента), а вставкой
// через executeJavaScript уже после загрузки живой страницы, см.
// createWindow ниже.
function detectLinuxBuildKind() {
  if (process.platform !== 'linux') return null;
  if (process.env.APPIMAGE) return 'AppImage';
  // electron-builder ставит .deb по умолчанию в /opt/<санитизированное
  // productName> — переносимый .tar.gz распаковывается куда угодно, так
  // что "не /opt и не AppImage" достаточно надёжно значит именно .tar.gz.
  if (app.getAppPath().startsWith('/opt/')) return 'deb';
  return 'tar.gz';
}

function windowTitle() {
  if (!app.isPackaged) return 'БАТТЛ · Админ (dev)';
  const kind = detectLinuxBuildKind();
  return kind ? `БАТТЛ · Админ (${kind})` : 'БАТТЛ · Админ';
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 560,
    title: windowTitle(),
    icon: path.join(__dirname, 'icon.png'), // значок окна/панели задач — тот же файл, что и у ярлыка меню приложений (см. install-launcher.sh) и у собранного AppImage/.deb (package.json → build.*.icon)
    autoHideMenuBar: true, // строка меню (File/Edit/...) панели не нужна — тут её просто прячем, а не убираем совсем, Alt всё ещё её покажет при необходимости
    backgroundColor: '#0b0b0f', // совпадает с тёмным фоном панели — без этого при загрузке на миг мелькает белый экран
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false, // страница панели не должна иметь доступ к Node.js API — это чужой веб-контент, пусть и наш собственный
    },
  });

  win.loadURL(ADMIN_URL);

  // Значок формата сборки рядом с "v4.5" в шапке панели — см. комментарий
  // у detectLinuxBuildKind выше про то, почему не в заголовке окна.
  // did-finish-load, а не once после первого loadURL: панель — SPA, но
  // мало ли (F5, восстановление после сбоя сети) — на каждую перезагрузку
  // страницы шапка отрисовывается заново, значок нужно вставлять снова.
  const buildKind = detectLinuxBuildKind();
  if (buildKind) {
    win.webContents.on('did-finish-load', () => {
      win.webContents.executeJavaScript(`
        (function () {
          var v = document.getElementById('admin-version');
          if (!v || document.getElementById('desktop-build-badge')) return;
          var badge = document.createElement('span');
          badge.id = 'desktop-build-badge';
          badge.textContent = ' · ${buildKind}';
          badge.style.cssText = 'font-size:11px; opacity:.55; font-weight:400; margin-left:2px;';
          v.insertAdjacentElement('afterend', badge);
        })();
      `).catch(() => {});
    });
  }

  // Ссылки, которые сама панель захочет открыть в новой вкладке (например,
  // "Политика конфиденциальности" в игре, если на неё где-то сослались),
  // должны уходить в обычный системный браузер, а не открывать второе окно
  // Electron без адресной строки — там их будет некуда закрыть иначе как Alt+F4.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Автообновление — только для самой обёртки (Electron-версия, иконка,
  // разрешения и т.п.), а не для содержимого панели: то обновляется само,
  // просто перезагрузкой живой страницы, без переустановки. Обёртка
  // меняется редко, но раз меняется — пусть само доставит новую версию,
  // а не заставляет заново качать файл с GitHub вручную. Работает только
  // в собранном (упакованном) приложении — в dev-режиме (npm start) молча
  // ничего не делает, поэтому обычный try/catch тут не нужен явно, но
  // логируем на всякий случай. Тихая проверка + тихая скачка + установка
  // при следующем запуске (или явном "Перезапустить сейчас" из
  // системного уведомления) — checkForUpdatesAndNotify делает всё это
  // сама, без своего UI внутри окна.
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.error('Автообновление: проверка не удалась', err);
    });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
