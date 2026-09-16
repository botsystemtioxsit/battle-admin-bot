// Десктоп-обёртка над той же самой веб-панелью — не отдельное приложение
// со своим кодом UI, а окно Electron, которое открывает ЖИВУЮ страницу
// панели (тот же адрес, что и в обычном браузере). Так апдейт панели
// (push в src/admin.html -> автосборка -> GitHub Pages/Vercel) сразу
// долетает и сюда, без пересборки и переустановки десктоп-приложения —
// то же самое, что уже происходит в браузере у всех остальных.
const { app, BrowserWindow, shell } = require('electron');

// URL, который видно в адресной строке браузера при открытии панели не из
// Telegram — тот же самый, просто в отдельном окне без браузерных вкладок/
// адресной строки. Вход внутри работает как обычно (email-заявка или
// токен доступа — см. screen-login в src/admin.html), никакой отдельной
// авторизации для самого приложения не требуется.
const ADMIN_URL = 'https://botsystemtioxsit.github.io/battle-admin-bot/public/admin.html';

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 560,
    title: 'БАТТЛ · Админ',
    autoHideMenuBar: true, // строка меню (File/Edit/...) панели не нужна — тут её просто прячем, а не убираем совсем, Alt всё ещё её покажет при необходимости
    backgroundColor: '#0b0b0f', // совпадает с тёмным фоном панели — без этого при загрузке на миг мелькает белый экран
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false, // страница панели не должна иметь доступ к Node.js API — это чужой веб-контент, пусть и наш собственный
    },
  });

  win.loadURL(ADMIN_URL);

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
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
