// Pryme Quant for Windows — a small desktop window around your Pryme Quant website.
// Updates arrive automatically: it always loads the latest version of the site.
const { app, BrowserWindow, shell, session } = require('electron');
const path = require('path');
let SITE = 'https://pryme-analyser.onrender.com';
try { SITE = require('./config.json').url || SITE; } catch { }
SITE = SITE.replace(/\/+$/, '');
// a normal Chrome user-agent, so Google sign-in treats the app like a regular browser
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

if (!app.requestSingleInstanceLock()) app.quit();
let win;
function create() {
  session.defaultSession.setUserAgent(UA);
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 380, minHeight: 600,
    backgroundColor: '#07090d', title: 'Pryme Quant', autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Google / Firebase sign-in popups open inside the app; every other link opens in your browser
    if (/accounts\.google\.com|\.firebaseapp\.com|googleapis\.com|\/__\/auth\//.test(url) || url.startsWith(SITE)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 700, autoHideMenuBar: true, parent: win } };
    }
    shell.openExternal(url); return { action: 'deny' };
  });
  win.loadURL(SITE + '/?source=windows');
}
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(create);
app.on('window-all-closed', () => app.quit());
