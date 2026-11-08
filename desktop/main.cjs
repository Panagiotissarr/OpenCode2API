const { app, Menu, Notification, Tray, nativeImage, shell } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const projectDir = app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..');
const dataDir = app.isPackaged ? app.getPath('userData') : projectDir;
const configPath = path.join(dataDir, 'config.json');
const runDir = path.join(dataDir, '.run');
const logPath = path.join(runDir, 'tray-proxy.log');
const HEALTH_INTERVAL_MS = 2500;
const STARTUP_TIMEOUT_MS = 30000;
const STOP_TIMEOUT_MS = 5000;

let tray;
let proxyProcess;
let proxyOwned = false;
let status = 'checking';
let quitting = false;
let pollTimer;
let startupTimer;
let stopPromise;

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
    app.quit();
} else {
    app.on('second-instance', () => showTrayMenu());
}

function readConfig() {
    try {
        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') writeLog(`[Tray] Could not read config.json: ${error.message}`);
        return {};
    }
}

function getPort() {
    const port = Number(readConfig().PORT);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : 10000;
}

function getBaseUrl() {
    return `http://127.0.0.1:${getPort()}`;
}

function writeLog(line) {
    try {
        fs.mkdirSync(runDir, { recursive: true });
        fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
    } catch (_) {
        // Logging should never prevent the tray app from starting.
    }
}

function checkHealth() {
    return new Promise((resolve) => {
        const request = http.get(`${getBaseUrl()}/health`, { timeout: 1500 }, (response) => {
            response.resume();
            resolve(response.statusCode === 200);
        });
        request.on('timeout', () => request.destroy());
        request.on('error', () => resolve(false));
    });
}

function statusText() {
    if (status === 'running') return 'Running';
    if (status === 'external') return 'Running (started elsewhere)';
    if (status === 'starting') return 'Starting…';
    if (status === 'stopping') return 'Stopping…';
    if (status === 'error') return 'Startup failed';
    return 'Stopped';
}

function makeTrayIcon() {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <rect x="2" y="2" width="28" height="28" rx="8" fill="#202b3c"/>
      <path d="M9 10h14M9 16h10M9 22h7" fill="none" stroke="#8ed8ca" stroke-width="2.6" stroke-linecap="round"/>
      <circle cx="23" cy="22" r="3" fill="#8ed8ca"/>
    </svg>`;
    const image = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    return image.resize({ width: 16, height: 16 });
}

function refreshTray() {
    if (!tray || tray.isDestroyed()) return;
    const state = statusText();
    tray.setToolTip(`opencode2api — ${state}`);
    const serviceAvailable = status === 'running' || status === 'external';
    const menu = Menu.buildFromTemplate([
        { label: `opencode2api: ${state}`, enabled: false },
        { type: 'separator' },
        {
            label: 'Start service',
            enabled: !serviceAvailable && status !== 'starting' && status !== 'stopping',
            click: startService
        },
        {
            label: 'Stop service',
            enabled: proxyOwned && (status === 'running' || status === 'starting' || status === 'error'),
            click: stopService
        },
        {
            label: 'Restart service',
            enabled: proxyOwned && status !== 'starting' && status !== 'stopping',
            click: restartService
        },
        {
            label: 'Open web panel',
            enabled: serviceAvailable && Boolean(readConfig().WEB_PANEL_ENABLED),
            click: () => shell.openExternal(`${getBaseUrl()}/panel`)
        },
        {
            label: 'Copy API base URL',
            enabled: serviceAvailable,
            click: () => {
                require('electron').clipboard.writeText(getBaseUrl());
                tray.displayBalloon?.({ title: 'API URL copied', content: getBaseUrl() });
            }
        },
        { type: 'separator' },
        { label: 'Edit JSON', click: editConfig },
        { label: 'Open logs', click: openLogs },
        { type: 'separator' },
        { label: 'Quit', click: quitApp }
    ]);
    tray.setContextMenu(menu);
}

function showTrayMenu() {
    if (tray && !tray.isDestroyed()) tray.popUpContextMenu();
}

function ensureConfig() {
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(configPath)) {
        fs.copyFileSync(path.join(projectDir, 'config.json.example'), configPath);
    }
}

async function editConfig() {
    try {
        ensureConfig();
        const error = await shell.openPath(configPath);
        if (error) throw new Error(error);
    } catch (error) {
        new Notification({ title: 'Could not open config.json', body: error.message }).show();
    }
}

async function openLogs() {
    try {
        fs.mkdirSync(runDir, { recursive: true });
        if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, '');
        const error = await shell.openPath(logPath);
        if (error) throw new Error(error);
    } catch (error) {
        new Notification({ title: 'Could not open logs', body: error.message }).show();
    }
}

function getServiceEnvironment() {
    const env = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        OPENCODE2API_CONFIG_PATH: configPath
    };
    if (process.platform === 'win32') {
        // Keep the 1.19 backend's state separate from a user's regular OpenCode install.
        env.XDG_DATA_HOME = app.isPackaged
            ? path.join(dataDir, '.opencode119', 'data')
            : path.resolve(projectDir, '..', '.opencode119', 'data');
        if (!env.OPENCODE_ZEN_API_KEY) {
            const candidates = [
                path.join(env.USERPROFILE || '', '.local', 'share', 'opencode', 'auth.json'),
                path.join(env.APPDATA || '', 'opencode', 'auth.json'),
                path.join(env.LOCALAPPDATA || '', 'opencode', 'auth.json')
            ];
            for (const candidate of candidates) {
                try {
                    const auth = JSON.parse(fs.readFileSync(candidate, 'utf8'));
                    if (auth.opencode?.key) {
                        env.OPENCODE_ZEN_API_KEY = auth.opencode.key;
                        break;
                    }
                } catch (_) {
                    // Try the next known OpenCode auth location.
                }
            }
        }
    }
    return env;
}

async function startService() {
    if (proxyProcess || status === 'starting' || status === 'stopping') return;
    status = 'starting';
    refreshTray();

    if (await checkHealth()) {
        status = 'external';
        proxyOwned = false;
        refreshTray();
        return;
    }

    try {
        fs.mkdirSync(runDir, { recursive: true });
        writeLog('[Tray] Starting proxy process');
        const indexPath = path.join(projectDir, 'index.js');
        proxyProcess = spawn(process.execPath, [indexPath], {
            cwd: dataDir,
            env: getServiceEnvironment(),
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            detached: process.platform !== 'win32'
        });
        proxyOwned = true;
        proxyProcess.stdout.on('data', (data) => {
            fs.appendFile(logPath, data, () => {});
        });
        proxyProcess.stderr.on('data', (data) => {
            fs.appendFile(logPath, data, () => {});
        });
        proxyProcess.once('error', (error) => {
            writeLog(`[Tray] Could not start proxy: ${error.message}`);
            proxyProcess = undefined;
            proxyOwned = false;
            status = 'error';
            clearTimeout(startupTimer);
            refreshTray();
        });
        proxyProcess.once('close', (code, signal) => {
            writeLog(`[Tray] Proxy exited (code=${code}, signal=${signal})`);
            proxyProcess = undefined;
            proxyOwned = false;
            clearTimeout(startupTimer);
            status = 'stopped';
            refreshTray();
        });
        startupTimer = setTimeout(() => {
            if (proxyProcess && status === 'starting') {
                status = 'error';
                writeLog('[Tray] Proxy did not become healthy before the startup timeout');
                refreshTray();
            }
        }, STARTUP_TIMEOUT_MS);
        refreshTray();
    } catch (error) {
        writeLog(`[Tray] Start failed: ${error.message}`);
        proxyProcess = undefined;
        proxyOwned = false;
        status = 'error';
        refreshTray();
        new Notification({ title: 'opencode2api failed to start', body: error.message }).show();
    }
}

function terminateOwnedProcess() {
    if (!proxyProcess) return Promise.resolve();
    const child = proxyProcess;
    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            if (process.platform === 'win32') {
                execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => finish());
            } else {
                try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { }
                finish();
            }
        }, STOP_TIMEOUT_MS);
        child.once('close', finish);
        try {
            if (process.platform === 'win32') child.kill('SIGTERM');
            else process.kill(-child.pid, 'SIGTERM');
        } catch (_) {
            finish();
        }
    });
}

async function stopService() {
    if (!proxyOwned || !proxyProcess || stopPromise) return stopPromise;
    status = 'stopping';
    refreshTray();
    writeLog('[Tray] Stopping proxy');
    stopPromise = terminateOwnedProcess();
    try {
        await stopPromise;
    } finally {
        stopPromise = undefined;
        if (!proxyProcess) {
            proxyOwned = false;
            status = 'stopped';
            refreshTray();
        }
    }
}

async function restartService() {
    await stopService();
    if (!quitting) await startService();
}

async function pollHealth() {
    if (quitting) return;
    const healthy = await checkHealth();
    if (healthy) {
        if (status === 'starting' || status === 'error' || status === 'checking' || status === 'stopped') {
            status = proxyOwned ? 'running' : 'external';
            clearTimeout(startupTimer);
            refreshTray();
        }
    } else if (status === 'running' || status === 'external') {
        status = proxyProcess ? 'starting' : 'stopped';
        refreshTray();
    }
}

async function quitApp() {
    if (quitting) return;
    quitting = true;
    clearInterval(pollTimer);
    clearTimeout(startupTimer);
    await stopService();
    app.quit();
}

app.whenReady().then(async () => {
    app.setAppUserModelId('com.opencode2api.tray');
    try {
        ensureConfig();
    } catch (error) {
        writeLog(`[Tray] Could not initialize config.json: ${error.message}`);
        new Notification({ title: 'Could not initialize config.json', body: error.message }).show();
    }
    tray = new Tray(makeTrayIcon());
    tray.setToolTip('opencode2api — Checking…');
    tray.on('click', showTrayMenu);
    tray.on('right-click', showTrayMenu);
    refreshTray();

    // Don't take control of a service started independently.
    if (await checkHealth()) {
        status = 'external';
        refreshTray();
    } else {
        await startService();
    }
    pollTimer = setInterval(pollHealth, HEALTH_INTERVAL_MS);
});

app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitApp();
});
