import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import * as crypto from 'crypto';
import * as http from 'http';
import { spawn, ChildProcess } from 'child_process';
import * as chokidar from 'chokidar';
import { getAllSecrets, getSecret, setSecret } from './secrets';
import * as gitSync from './gitSync';
import * as QRCode from 'qrcode';
import { PhoneServer, lanAddresses } from './phoneServer';
import { migrateFromSmartNotes, MigrationResult } from './migrateFromSmartNotes';

// Only one Dogear may run at a time: two backends would fight over the same files.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;
let backendPort = 0;
let isQuitting = false;
let backendReady = false;
const backendRestarts: number[] = [];
const dirtyNoteIds = new Set<string>();
const ipcToken = crypto.randomBytes(32).toString('hex');

const SMARTNOTES_DIR = process.env.SMARTNOTES_DIR || path.join(app.getPath('documents'), 'Dogear');
let migration: MigrationResult = { notesMovedFrom: null, dataCopied: [], secretsNeedReentry: false };
const RENAME_WINDOW_MS = 2000;

const backendUrl = () => `http://127.0.0.1:${backendPort}`;

function log(...args: unknown[]) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}\n`;
  process.stdout.write(line);
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'main.log'), line);
  } catch {
    // logging must never crash the app
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function pollHealthCheck(timeoutMs = 60000): Promise<boolean> {
  const start = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      if (!backendProcess || backendProcess.exitCode !== null) return resolve(false);
      const req = http.get(`${backendUrl()}/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve(true);
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(2000, () => req.destroy());
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) resolve(false);
      else setTimeout(check, 500);
    };
    check();
  });
}

/** The command that starts the backend: bundled binary when packaged, venv python in dev. */
function backendCommand(): { cmd: string; args: string[]; cwd: string } {
  if (app.isPackaged) {
    const exe = process.platform === 'win32' ? 'dogear-backend.exe' : 'dogear-backend';
    const dir = path.join(process.resourcesPath, 'backend');
    return { cmd: path.join(dir, exe), args: [], cwd: dir };
  }
  const root = app.getAppPath();
  const python = path.join(root, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
  return { cmd: python, args: ['-m', 'backend.main'], cwd: root };
}

function spawnBackend() {
  if (process.env.SMARTNOTES_SIMULATE_BACKEND_FAILURE === 'true') {
    log('Simulating backend failure - skipping spawn');
    return;
  }
  const { cmd, args, cwd } = backendCommand();
  log(`Starting backend: ${cmd} ${args.join(' ')} on port ${backendPort}`);
  backendProcess = spawn(cmd, args, {
    cwd,
    windowsHide: true,
    env: {
      ...process.env,
      IPC_TOKEN: ipcToken,
      SMARTNOTES_DIR,
      SMARTNOTES_DATA_DIR: app.getPath('userData'),
      SMARTNOTES_PORT: String(backendPort),
      SMARTNOTES_PARENT_PID: String(process.pid),
      ...(migration.notesMovedFrom ? { SMARTNOTES_PREVIOUS_DIR: migration.notesMovedFrom } : {}),
      PYTHONPATH: app.isPackaged ? '' : app.getAppPath(),
      PYTHONUNBUFFERED: '1',
      SMARTNOTES_MODELS_DIR: app.isPackaged
        ? path.join(process.resourcesPath, 'models')
        : path.join(app.getAppPath(), 'resources', 'models'),
    },
  });

  backendProcess.stdout?.on('data', (data) => process.stdout.write(`Backend: ${data}`));
  backendProcess.stderr?.on('data', (data) => process.stderr.write(`Backend: ${data}`));
  backendProcess.on('error', (err) => log(`Backend failed to start: ${err.message}`));
  backendProcess.on('exit', (code, signal) => {
    log(`Backend exited (code ${code}, signal ${signal})`);
    backendProcess = null;
    if (!isQuitting && backendReady) void restartBackend();
  });
}

async function restartBackend() {
  const now = Date.now();
  while (backendRestarts.length && now - backendRestarts[0] > 60_000) backendRestarts.shift();
  if (backendRestarts.length >= 3) {
    log('Backend crashed 3 times in a minute; giving up');
    backendReady = false;
    mainWindow?.loadFile(errorPage());
    return;
  }
  backendRestarts.push(now);
  mainWindow?.webContents.send('backend-status', 'restarting');
  spawnBackend();
  if (await pollHealthCheck()) {
    mainWindow?.webContents.send('backend-status', 'ready');
  }
}

function errorPage() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'error.html')
    : path.join(app.getAppPath(), 'renderer', 'error.html');
}

function installSecurityPolicy() {
  const connect = `'self' http://127.0.0.1:${backendPort}` + (app.isPackaged ? '' : ' ws://localhost:5173 http://localhost:5173');
  const script = app.isPackaged ? "'self'" : "'self' 'unsafe-inline' 'unsafe-eval' http://localhost:5173";
  const csp = [
    "default-src 'self'",
    `script-src ${script}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
  ].join('; ');
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
  });
  // The app never needs camera, mic, notifications, etc.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
}

function createWindow(isError = false) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 500,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // Links open in the user's browser; the app window never navigates away
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = app.isPackaged ? url.startsWith('file://') : url.startsWith('http://localhost:5173');
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });

  if (isError) {
    mainWindow.loadFile(errorPage());
  } else if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function postFsEvent(event: string, filePath: string) {
  const payload = JSON.stringify({ event, path: filePath, dirty_note_ids: Array.from(dirtyNoteIds) });
  const req = http.request(`${backendUrl()}/api/sync/fs-event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-IPC-Token': ipcToken },
  });
  req.on('error', (e) => log(`[Sync] ${e.message}`));
  req.on('response', (res) => {
    let body = '';
    res.on('data', (chunk) => (body += chunk));
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.status === 'conflict' && data.note_id) {
          mainWindow?.webContents.send('file-conflict', data.note_id);
        } else if (data.status === 'processed') {
          mainWindow?.webContents.send('sync-refresh');
          // A deleted file is removed only after the rename window, so refresh again then
          if (data.action === 'unlink_tracked') {
            setTimeout(() => mainWindow?.webContents.send('sync-refresh'), RENAME_WINDOW_MS + 500);
          }
        }
      } catch {
        log('[Sync] Failed to parse response');
      }
    });
  });
  req.write(payload);
  req.end();
}

function setupWatcher() {
  const watcher = chokidar.watch(SMARTNOTES_DIR, {
    ignored: /(^|[/\\])\..*|\.tmp$|\.swp$|~$/, // dotfiles/dirs (.git), temp and swap files
    persistent: true,
    ignoreInitial: true, // startup changes are handled by the backend's reconcile pass
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });
  watcher.on('all', (event, filePath) => {
    if (!filePath.endsWith('.md')) return;
    if (event === 'add' || event === 'change' || event === 'unlink') postFsEvent(event, filePath);
  });
  watcher.on('error', (err) => log(`[Watcher] ${err}`));
}

let syncInProgress = false;

// --- Phone access (off unless the user turns it on in Settings) ---
const PHONE_PORT = 47800; // stable, so a phone's bookmark keeps working
let phone: PhoneServer | null = null;
const phoneSettingsPath = () => path.join(app.getPath('userData'), 'phone-settings.json');

function phoneEnabledSetting(): boolean {
  try {
    return JSON.parse(fs.readFileSync(phoneSettingsPath(), 'utf-8')).enabled === true;
  } catch {
    return false;
  }
}

function getPhone(): PhoneServer {
  if (!phone) {
    phone = new PhoneServer({
      dataDir: app.getPath('userData'),
      phoneDir: app.isPackaged ? path.join(process.resourcesPath, 'phone') : path.join(app.getAppPath(), 'phone'),
      backendUrl,
      ipcToken,
      isNoteDirty: (id) => dirtyNoteIds.has(id),
      onNotesChanged: () => mainWindow?.webContents.send('sync-refresh'),
      onDevicesChanged: () => mainWindow?.webContents.send('phone-devices-changed'),
      preferredPort: PHONE_PORT,
    });
  }
  return phone;
}

function phoneState() {
  const p = getPhone();
  return {
    enabled: p.isRunning,
    port: p.port,
    addresses: lanAddresses(),
    devices: p.listDevices(),
  };
}

async function setPhoneEnabled(enabled: boolean) {
  const p = getPhone();
  if (enabled) {
    const port = await p.start();
    log(`[Phone] listening on port ${port}`);
  } else {
    await p.stop();
    log('[Phone] stopped');
  }
  fs.writeFileSync(phoneSettingsPath(), JSON.stringify({ enabled }), { mode: 0o600 });
  return phoneState();
}

function registerIpc() {
  ipcMain.handle('get-ipc-token', () => ipcToken);
  ipcMain.handle('get-backend-url', () => backendUrl());
  ipcMain.handle('secrets:get-all', () => getAllSecrets());
  ipcMain.handle('secrets:set', (_e, name: string, value: string) => setSecret(name, value));
  ipcMain.handle('get-notes-dir', () => SMARTNOTES_DIR);

  ipcMain.handle('dialog:choose-folder', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import a folder of Markdown notes',
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('git:sync', async (_e, action: 'push' | 'pull', repoUrl: string) => {
    if (syncInProgress) return { ok: false, message: 'A sync is already running.', log: [] };
    syncInProgress = true;
    try {
      const token = getSecret('githubPat');
      const result = action === 'push'
        ? await gitSync.push(SMARTNOTES_DIR, repoUrl, token)
        : await gitSync.pull(SMARTNOTES_DIR, repoUrl, token);
      log(`[Git] ${action}: ${result.ok ? 'ok' : 'failed'} - ${result.message}`);
      return result;
    } finally {
      syncInProgress = false;
    }
  });

  ipcMain.handle('phone:get-state', () => phoneState());
  ipcMain.handle('phone:set-enabled', (_e, enabled: boolean) => setPhoneEnabled(enabled === true));
  ipcMain.handle('phone:revoke', (_e, id: string) => {
    getPhone().revokeDevice(String(id));
    return phoneState();
  });
  ipcMain.handle('phone:pair', async () => {
    const p = getPhone();
    if (!p.isRunning) await setPhoneEnabled(true);
    const [address] = lanAddresses();
    if (!address) {
      return { error: "This Mac isn't connected to a Wi-Fi or local network." };
    }
    const { code, expiresAt } = p.createPairingCode();
    // The code travels in the URL fragment, which browsers never send to the server or log
    const url = `http://${address}:${p.port}/#pair?code=${code}`;
    const qr = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { code, expiresAt, url, address: `http://${address}:${p.port}`, qrSvg: qr };
  });

  ipcMain.on('set-dirty', (_e, { noteId, isDirty }: { noteId: string; isDirty: boolean }) => {
    if (typeof noteId !== 'string') return;
    if (isDirty) dirtyNoteIds.add(noteId);
    else dirtyNoteIds.delete(noteId);
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

/** SmartNotes was renamed Dogear: bring existing users' notes and data across (once). */
function runRenameMigration() {
  if (process.env.SMARTNOTES_DIR) return; // custom folder (tests, power users): leave it alone
  try {
    migration = migrateFromSmartNotes({
      oldNotesDir: path.join(app.getPath('documents'), 'SmartNotes'),
      newNotesDir: SMARTNOTES_DIR,
      oldDataDir: path.join(app.getPath('appData'), 'SmartNotes'),
      newDataDir: app.getPath('userData'),
    });
    if (migration.notesMovedFrom || migration.dataCopied.length) {
      log(`[Rename] notes moved from ${migration.notesMovedFrom ?? '(none)'}; copied ${migration.dataCopied.join(', ')}`);
    }
  } catch (e) {
    log(`[Rename] migration failed: ${(e as Error).message}`);
  }
}

function explainRename() {
  if (!mainWindow || (!migration.notesMovedFrom && !migration.dataCopied.length)) return;
  const lines = ['SmartNotes is now called Dogear. Everything you had is still here.'];
  if (migration.notesMovedFrom) lines.push(`Your notes folder moved to ${SMARTNOTES_DIR}.`);
  if (migration.secretsNeedReentry) {
    lines.push('For security, saved API keys and your GitHub token have to be entered again in Settings.');
  }
  lines.push('You can delete the old SmartNotes app.');
  void dialog.showMessageBox(mainWindow, {
    type: 'info',
    message: 'Welcome to Dogear',
    detail: lines.join('\n\n'),
    buttons: ['OK'],
  });
}

app.whenReady().then(async () => {
  runRenameMigration();
  // Packaged builds get the icon from the bundle; show it in dev too instead of Electron's
  if (!app.isPackaged && process.platform === 'darwin') {
    app.dock?.setIcon(path.join(app.getAppPath(), 'build', 'icon.png'));
  }
  fs.mkdirSync(SMARTNOTES_DIR, { recursive: true });
  backendPort = Number(process.env.SMARTNOTES_PORT) || (await findFreePort());
  registerIpc();
  installSecurityPolicy();

  spawnBackend();
  backendReady = await pollHealthCheck();
  if (backendReady) {
    createWindow(false);
    mainWindow?.once('ready-to-show', explainRename);
    setupWatcher();
    if (phoneEnabledSetting()) {
      setPhoneEnabled(true).catch((e) => log(`[Phone] could not start: ${e.message}`));
    }
  } else {
    log('Backend did not become healthy');
    createWindow(true);
  }

  // macOS: clicking the dock icon with no windows open reopens the app window
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(!backendReady);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  void phone?.stop();
  if (backendProcess && backendProcess.exitCode === null) {
    backendProcess.kill();
  }
});
