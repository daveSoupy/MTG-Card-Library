/**
 * MTG Library as a desktop app — the Electron main process, and the only
 * process the shell has. There is no renderer code: the window loads
 * `http://127.0.0.1:<port>/` and the existing web client renders as it does
 * in a browser. The server is `server/dist/index.js`, unmodified, as a child
 * process on a bundled official Node binary (`server.ts`).
 *
 * What the shell decides (`config.ts`): the port, whether the server answers
 * on the LAN, whether the machine may sleep, whether it starts at login. What
 * it does: keeps the server up, shows a window when asked, and stops the
 * server only on an explicit Quit. Closing the window hides it — on every
 * platform, no cleverness about when close means quit.
 */

import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  dialog,
  nativeImage,
  powerSaveBlocker,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { choosePort, readConfig, writeConfig, type DesktopConfig } from './config.ts';
import { RotatingLog, bootMessage } from './logging.ts';
import { ServerProcess, waitForHealth } from './server.ts';
import { manualCheckMessage, updateStatusLine } from './updateState.ts';
import { Updates } from './updates.ts';

const APP_NAME = 'MTG Library';
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

// ---------- where things are ----------------------------------------------

// Development only: a separate userData so a test run leaves the real
// install's config, logs and login-item registration alone.
if (process.env.MTG_DESKTOP_USER_DATA) app.setPath('userData', process.env.MTG_DESKTOP_USER_DATA);
if (isWindows) app.setAppUserModelId('com.davesoupy.mtglibrary');

/**
 * The repository-shaped tree the server runs from: `schema.sql`, `server/dist`,
 * `web/dist` and a production `node_modules`, because `server/dist/index.js`
 * finds the first two by walking up from its own path. Packaged, it is the
 * staging directory shipped as `Resources/mtg-library`; in development it is
 * the repository itself after `npm run build`.
 */
function bundleRoot(): string {
  return app.isPackaged ? join(process.resourcesPath, 'mtg-library') : join(import.meta.dirname, '..', '..');
}

/** The Node binary the server runs on. Never Electron's own. */
function nodeBinary(): string {
  const name = isWindows ? 'node.exe' : 'node';
  if (app.isPackaged) return join(process.resourcesPath, 'node', name);
  // Development: the binary fetch-node.mjs downloaded when there is one, else
  // whatever `node` is on PATH — a developer has one.
  const fetched = join(import.meta.dirname, '..', 'vendor', 'node', `${process.platform}-${process.arch}`, name);
  return existsSync(fetched) ? fetched : name;
}

function asset(name: string): string {
  return join(import.meta.dirname, '..', 'assets', name);
}

const userData = app.getPath('userData');
const configPath = join(userData, 'desktop-config.json');
const logsDir = join(userData, 'logs');
// The server's default is a Linux convention (~/.local/share); the app's own
// support directory is the right place on a Mac or PC. An MTG_DATA_DIR
// already in the environment wins so a developer can point the app at an
// existing library.
const dataDir = process.env.MTG_DATA_DIR && process.env.MTG_DATA_DIR.length > 0
  ? process.env.MTG_DATA_DIR
  : join(userData, 'library');

// ---------- state ------------------------------------------------------------

const firstLaunch = !existsSync(configPath);
const config: DesktopConfig = readConfig(configPath);
const log = new RotatingLog(join(logsDir, 'server.log'));
const server = new ServerProcess();
// Phase 34: checks on launch and daily, downloads in the background, applies
// on quit. Its only visible surface is two tray items and one dialog the
// user asks for.
const updates = new Updates(log);

let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let port: number | null = null;
let quitting = false;
let restarting = false;
let blockerId: number | null = null;
/** Timestamps of recent unexpected exits, to stop restarting a server that cannot start. */
const crashTimes: number[] = [];

// The status page: what the window shows while the server is not answering.
let statusTitle = '';
let statusSubtitle = '';
let statusLines: string[] = [];
let showingStatus = false;

function saveConfig(): void {
  try {
    writeConfig(configPath, config);
  } catch (error) {
    log.note(`could not save config: ${(error as Error).message}`);
  }
}

function serverUrl(): string {
  return `http://127.0.0.1:${port}/`;
}

function openExternal(url: string): void {
  if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
}

// ---------- the status page ------------------------------------------------

// The only markup the shell owns: a title, a line under it, and the server's
// own boot messages. Loaded as a data: URL; `__mtg` is how main pushes text
// into it. Colours are the web app's default theme.
const STATUS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>${APP_NAME}</title>
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; margin: 0; background: #10131a; color: #e7ecf5;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  body { display: flex; align-items: center; justify-content: center; -webkit-user-select: none; }
  main { width: min(560px, 88vw); }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; display: flex; align-items: center; gap: 10px; }
  h1::before { content: ""; width: 12px; height: 12px; border-radius: 50%; background: #d98a3f;
    animation: pulse 1.2s ease-in-out infinite; flex: none; }
  p { margin: 0 0 16px; color: #9aa5b8; }
  pre { margin: 0; padding: 12px 14px; background: #161b26; border-radius: 8px; color: #9aa5b8;
    font: 12px/1.6 ui-monospace, Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-word;
    max-height: 240px; overflow: hidden; }
  pre:empty { display: none; }
  @keyframes pulse { 50% { opacity: .35; } }
</style></head><body><main><h1 id="t"></h1><p id="s"></p><pre id="l"></pre></main>
<script>
  window.__mtg = (t, s, l) => {
    document.getElementById('t').textContent = t;
    document.getElementById('s').textContent = s;
    document.getElementById('l').textContent = l.join('\\n');
  };
</script></body></html>`;

function pushStatus(): void {
  if (!showingStatus || !win) return;
  win.webContents
    .executeJavaScript(`window.__mtg(${JSON.stringify(statusTitle)}, ${JSON.stringify(statusSubtitle)}, ${JSON.stringify(statusLines)})`)
    .catch(() => {
      // The page is mid-navigation; the next push catches up.
    });
}

function showStatus(title: string, subtitle: string): void {
  statusTitle = title;
  statusSubtitle = subtitle;
  showingStatus = true;
  if (!win) return;
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(STATUS_HTML)}`)
    .then(pushStatus)
    .catch(() => {});
}

function loadApp(): void {
  showingStatus = false;
  win?.loadURL(serverUrl()).catch(() => {});
}

// ---------- the server -------------------------------------------------------

server.on('line', (line) => {
  const message = bootMessage(line);
  if (message === null) return;
  statusLines.push(message);
  if (statusLines.length > 12) statusLines.shift();
  pushStatus();
});

server.on('exit', ({ expected }) => {
  updateTray();
  if (quitting || expected) return;

  const now = Date.now();
  crashTimes.push(now);
  while (crashTimes.length > 0 && crashTimes[0]! < now - 5 * 60_000) crashTimes.shift();
  if (crashTimes.length > 3) {
    log.note('the server stopped four times in five minutes; not restarting it again');
    showStatus('The server keeps stopping', 'Show logs (from the menu-bar or tray menu) says why. Quit and reopen to try again.');
    showWindow();
    return;
  }
  showStatus('The server stopped unexpectedly', 'Starting it again…');
  setTimeout(() => {
    if (!quitting && !server.running && !restarting) void startServer();
  }, 1_000);
});

async function startServer(): Promise<void> {
  const host = config.sharing ? '0.0.0.0' : '127.0.0.1';
  statusLines = [];
  showStatus(`Starting ${APP_NAME}…`, 'The first start after an update can take a few seconds.');
  try {
    port = await choosePort(config.port, host);
  } catch (error) {
    log.note((error as Error).message);
    showStatus('No free port', (error as Error).message);
    showWindow();
    return;
  }
  if (config.port !== port) {
    config.port = port;
    saveConfig();
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  Object.assign(env, {
    MTG_DATA_DIR: dataDir,
    MTG_HOST: host,
    MTG_PORT: String(port),
    MTG_LOG_LEVEL: process.env.MTG_LOG_LEVEL ?? 'info',
    // Phase 33: advertise over mDNS exactly when other devices may connect.
    // The server also refuses to advertise a loopback bind, so this and
    // MTG_HOST cannot disagree in a way that matters.
    MTG_ADVERTISE: host === '0.0.0.0' ? '1' : '0',
    MTG_SHUTDOWN_ON_STDIN_CLOSE: '1',
    NODE_ENV: 'production',
  });
  const root = bundleRoot();
  server.start({ node: nodeBinary(), entry: join(root, 'server', 'dist', 'index.js'), cwd: root, env, log });
  updateTray();

  try {
    await waitForHealth(`${serverUrl()}api/v1/health`, { alive: () => server.running });
  } catch {
    return; // the exit handler has already taken over
  }
  loadApp();
  // After loadApp: "Pair a phone…" is enabled only once the status page is gone.
  updateTray();
}

/** Stop and start again — the sharing toggle changes MTG_HOST, which only a fresh process can bind. */
async function restartServer(): Promise<void> {
  if (restarting) return;
  restarting = true;
  try {
    await server.stop();
    await startServer();
  } finally {
    restarting = false;
  }
}

// ---------- the window -------------------------------------------------------

function rememberBounds(): void {
  if (!win || win.isMinimized() || win.isFullScreen()) return;
  config.windowBounds = win.getNormalBounds();
  saveConfig();
}

function createWindow(): BrowserWindow {
  const bounds = config.windowBounds ?? { width: 1280, height: 860 };
  const window = new BrowserWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: APP_NAME,
    backgroundColor: '#10131a',
    autoHideMenuBar: !isMac,
    webPreferences: {
      // The page is the web client over HTTP; it has no reason to touch Node.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Close hides. Quit is ⌘Q or the tray, and only that stops the server.
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    rememberBounds();
    window.hide();
  });

  // Links out of the app (Scryfall, TCGplayer) open in the user's browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(serverUrl())) return;
    event.preventDefault();
    openExternal(url);
  });

  return window;
}

function showWindow(): void {
  if (!win) win = createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * Phase 33: the tray's "Pair a phone…". The pairing panel is the web app's
 * (Data page, `#pair` scrolls to it) — the shell only points the window at
 * it. While the server is still starting the status page stays; the item
 * is disabled then, so this is only reached with the app loaded.
 */
function openPairing(): void {
  showWindow();
  if (showingStatus || !server.running) return;
  win?.loadURL(`${serverUrl()}data#pair`).catch(() => {});
}

// ---------- settings that act ----------------------------------------------

function applyPowerBlocker(): void {
  const want = config.sharing && config.keepAwake;
  if (want && blockerId === null) {
    blockerId = powerSaveBlocker.start('prevent-app-suspension');
    log.note('keeping the computer awake while sharing');
  } else if (!want && blockerId !== null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
    log.note('no longer keeping the computer awake');
  }
}

function applyLoginItem(): void {
  // In development the executable is Electron itself; registering that as a
  // login item would be wrong. Only the packaged app registers.
  if (!app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin: config.launchAtLogin,
    // Windows passes this back on a login launch so the window starts hidden.
    ...(isWindows ? { args: ['--hidden'] } : {}),
  });
}

const FIREWALL_DETAIL =
  'When sharing turns on, Windows Defender Firewall will ask whether to allow node.exe ' +
  '(the server inside MTG Library) to accept connections. Choose Allow for private networks — ' +
  'if it is blocked, phones on your wifi will not be able to find the app, and the toggle will ' +
  'look on while nothing answers. Show logs is where that gets diagnosed.';

async function setSharing(on: boolean): Promise<void> {
  if (on && isWindows && !config.firewallExplained) {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: APP_NAME,
      message: 'Windows will ask about the firewall',
      detail: FIREWALL_DETAIL,
      buttons: ['Turn on sharing', 'Not now'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) {
      updateTray();
      return;
    }
    config.firewallExplained = true;
  }
  config.sharing = on;
  saveConfig();
  log.note(`sharing ${on ? 'on' : 'off'}`);
  applyPowerBlocker();
  updateTray();
  await restartServer();
}

function setKeepAwake(on: boolean): void {
  config.keepAwake = on;
  saveConfig();
  applyPowerBlocker();
  updateTray();
}

function setLaunchAtLogin(on: boolean): void {
  config.launchAtLogin = on;
  saveConfig();
  applyLoginItem();
  updateTray();
}

// ---------- updates ------------------------------------------------------------

let checkingManually = false;

/**
 * "Check for updates…": the one time the updater is allowed a dialog, because
 * the user asked. The automatic checks say nothing; a downloaded update only
 * ever shows up as the tray's "Restart to update".
 */
async function checkForUpdatesManually(): Promise<void> {
  if (checkingManually) return;
  checkingManually = true;
  updateTray();
  try {
    const state = await updates.check();
    const { message, detail } = manualCheckMessage(state, app.getVersion());
    await dialog.showMessageBox({ type: state.kind === 'error' ? 'warning' : 'info', title: APP_NAME, message, detail, buttons: ['OK'] });
  } finally {
    checkingManually = false;
    updateTray();
  }
}

// ---------- menus ------------------------------------------------------------

function trayTemplate(): MenuItemConstructorOptions[] {
  const status = !server.running ? 'Server stopped' : port === null ? 'Starting…' : `Running on port ${port}`;
  return [
    { label: status, enabled: false },
    { label: `Open ${APP_NAME}`, click: showWindow },
    { type: 'separator' },
    {
      label: 'Allow other devices on this network',
      type: 'checkbox',
      checked: config.sharing,
      click: (item) => void setSharing(item.checked),
    },
    {
      label: 'Keep this computer awake while sharing',
      type: 'checkbox',
      checked: config.keepAwake,
      click: (item) => setKeepAwake(item.checked),
    },
    { label: 'Launch at login', type: 'checkbox', checked: config.launchAtLogin, click: (item) => setLaunchAtLogin(item.checked) },
    { type: 'separator' },
    { label: 'Pair a phone…', enabled: server.running && port !== null && !showingStatus, click: openPairing },
    { label: 'Show data folder', click: () => void shell.openPath(dataDir) },
    { label: 'Show logs', click: () => void shell.openPath(logsDir) },
    ...updateItems(),
    { type: 'separator' },
    { label: `Quit ${APP_NAME}`, click: () => app.quit() },
  ];
}

/**
 * The updater's two items. "Restart to update" exists only while an update
 * is staged; "Check for updates…" is disabled while a check or download is
 * under way (the status line above it says which), and in development,
 * where there is nothing to check.
 */
function updateItems(): MenuItemConstructorOptions[] {
  const state = updates.state;
  const line = updateStatusLine(state);
  const busy = checkingManually || state.kind === 'checking' || state.kind === 'downloading';
  return [
    ...(line ? [{ label: line, enabled: false }] : []),
    ...(state.kind === 'ready' ? [{ label: `Restart to update to ${state.version}`, click: () => updates.restartToUpdate() }] : []),
    { label: 'Check for updates…', enabled: updates.active && !busy && state.kind !== 'ready', click: () => void checkForUpdatesManually() },
  ];
}

function updateTray(): void {
  tray?.setContextMenu(Menu.buildFromTemplate(trayTemplate()));
}

let trayImage: Electron.NativeImage | null = null;

function createTray(): void {
  // macOS: a template image (black + alpha, file name ending in "Template")
  // that the menu bar tints. Windows: the app icon in colour.
  trayImage = nativeImage.createFromPath(asset(isMac ? 'trayTemplate.png' : 'tray.png'));
  if (trayImage.isEmpty()) log.note(`tray icon did not load from ${asset(isMac ? 'trayTemplate.png' : 'tray.png')}`);
  tray = new Tray(trayImage);
  tray.setToolTip(APP_NAME);
  // With a context menu set, a macOS click opens the menu; on Windows a click
  // does nothing by default, so make it open the window.
  if (!isMac) tray.on('click', showWindow);
  updateTray();
}

function applicationMenu(): Menu {
  const help: MenuItemConstructorOptions = {
    role: 'help',
    submenu: [
      { label: 'Show logs', click: () => void shell.openPath(logsDir) },
      { label: 'Show data folder', click: () => void shell.openPath(dataDir) },
      { type: 'separator' },
      { label: `${APP_NAME} on GitHub`, click: () => openExternal('https://github.com/daveSoupy/MTG-Card-Library') },
    ],
  };
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    help,
  ];
  return Menu.buildFromTemplate(template);
}

// ---------- lifecycle --------------------------------------------------------

async function showBackgroundNoticeOnce(): Promise<void> {
  if (config.backgroundNoticeShown || !win) return;
  config.backgroundNoticeShown = true;
  saveConfig();
  await dialog.showMessageBox(win, {
    type: 'info',
    title: APP_NAME,
    message: `${APP_NAME} runs in the background`,
    detail: `Closing this window keeps it running — find it in the ${isMac ? 'menu bar' : 'system tray'}. Quit from there to stop it.`,
    buttons: ['OK'],
  });
}

async function shutdown(): Promise<void> {
  rememberBounds();
  // A bulk sync mid-write can take up to the server's own 10s ceiling to stop.
  const slow = setTimeout(() => {
    tray?.setToolTip('Finishing up…');
    if (isMac) tray?.setTitle('Finishing up…');
    if (win?.isVisible()) showStatus('Finishing up…', 'Waiting for the server to close the database.');
  }, 1_000);
  const { graceful } = await server.stop();
  clearTimeout(slow);
  updates.stop();
  log.note(graceful ? 'quit' : 'quit after killing a server that would not stop');
  log.close();
  // Through app.quit(), not app.exit(): `quitting` is set, so before-quit and
  // the window's close handler now let it through, and Electron's `quit`
  // event fires — which is where electron-updater installs a downloaded
  // update (Windows) and what Squirrel.Mac waits on. app.exit() skips it.
  app.quit();
}

async function main(): Promise<void> {
  await app.whenReady();
  log.note(`launch (${app.isPackaged ? 'packaged' : 'development'}, userData ${userData})`);

  if (firstLaunch) {
    saveConfig();
    applyLoginItem();
  } else if (app.isPackaged) {
    // The user may have changed this in System Settings; the OS is the truth.
    config.launchAtLogin = app.getLoginItemSettings().openAtLogin;
  }
  applyPowerBlocker();

  Menu.setApplicationMenu(applicationMenu());
  createTray();

  // Launched at login, the point is the server, not the window.
  const launchedAtLogin = process.argv.includes('--hidden') || (isMac && app.getLoginItemSettings().wasOpenedAtLogin);
  win = createWindow();
  if (!launchedAtLogin) showWindow();

  app.on('activate', showWindow);
  app.on('second-instance', showWindow);
  // Windows never all close — close hides — but the default here would quit.
  app.on('window-all-closed', () => {});
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void shutdown();
  });

  await startServer();
  if (!launchedAtLogin) await showBackgroundNoticeOnce();
  // After the server is up: an update check is the least urgent thing at launch.
  updates.on('change', updateTray);
  updates.start();
}

// Scripted verification (scripts/verify-lifecycle.mjs): the tray's actions,
// reachable over `electron --inspect` without a click. Never set by a
// packaged launch.
if (process.env.MTG_DESKTOP_INSPECT === '1') {
  Object.assign(globalThis, {
    __mtgDesktop: {
      setSharing,
      setKeepAwake,
      setLaunchAtLogin,
      showWindow,
      openPairing,
      closeWindow: () => win?.close(),
      quit: () => app.quit(),
      state: () => ({
        port,
        running: server.running,
        pid: server.pid,
        sharing: config.sharing,
        // What the child was told; the server's own gate is the truth.
        advertise: server.running && config.sharing,
        keepAwake: config.keepAwake,
        visible: win?.isVisible() ?? false,
        url: win?.webContents.getURL() ?? null,
        blocking: blockerId !== null && powerSaveBlocker.isStarted(blockerId),
        // What the OS says, not the config: null in development, which never registers.
        loginItem: app.isPackaged ? app.getLoginItemSettings().openAtLogin : null,
        // An empty image is an invisible menu-bar item — worth asserting on a packaged build.
        trayIcon: trayImage ? { empty: trayImage.isEmpty(), template: trayImage.isTemplateImage(), ...trayImage.getSize() } : null,
        update: updates.state,
        version: app.getVersion(),
      }),
      checkForUpdates: () => updates.check(),
    },
  });
}

if (!app.requestSingleInstanceLock()) {
  // A second launch just brings the first one's window forward.
  app.quit();
} else {
  void main();
}
