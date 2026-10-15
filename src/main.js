/**
 * Feliz Cristais Impressora
 * Fica na bandeja do sistema (ao lado do relógio), consulta a fila de pedidos do site a cada poucos
 * segundos e imprime o cupom na impressora escolhida, sem janela de confirmação.
 * Inicia junto com o computador e se atualiza sozinho pelas versões publicadas no GitHub.
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { autoUpdater } = require('electron-updater');

// Perfil separado para testes (desenvolvimento): FC_USER_DATA=pasta
if (process.env.FC_USER_DATA) app.setPath('userData', process.env.FC_USER_DATA);

// Uma cópia só (abrir de novo traz a janela da que já está rodando)
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');
const DEFAULTS = { site: '', key: '', printer: '', copies: 1, every: 5, autostart: true, notify: true };
let config = { ...DEFAULTS };
let tray = null;
let win = null;
let timer = null;
let busy = false;
let state = { online: false, message: 'Configure o endereço do site e a chave de impressão.', last: null, printed: 0 };
const log = [];

function loadConfig() {
  try {
    config = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8')) };
  } catch (e) {
    config = { ...DEFAULTS };
  }
}
function saveConfig() {
  fs.mkdirSync(path.dirname(CONFIG_FILE()), { recursive: true });
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify(config, null, 2));
}
function addLog(text, kind = 'info') {
  log.unshift({ at: new Date().toLocaleTimeString('pt-BR'), text, kind });
  log.splice(60);
  send('log', log);
}
function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}
function setState(patch) {
  state = { ...state, ...patch };
  send('state', state);
  updateTray();
}

// ---------------------------------------------------------------- Site
function apiUrl(action, extra = '') {
  const base = config.site.trim().replace(/\/+$/, '').replace(/\/admin\/print_api(\.php)?$/, '');
  return `${base}/admin/print_api.php?action=${action}&station=${encodeURIComponent(os.hostname())}${extra}`;
}
async function api(action, { method = 'GET', extra = '' } = {}) {
  const r = await fetch(apiUrl(action, extra), {
    method,
    headers: { 'X-Print-Key': config.key.trim(), 'User-Agent': `FelizCristaisImpressora/${app.getVersion()}` },
    signal: AbortSignal.timeout(20000),
  });
  if (r.status === 204) return null;
  if (r.status === 401) throw new Error('Chave de impressão inválida. Copie de novo no painel (Impressão de pedidos).');
  if (!r.ok) throw new Error(`O site respondeu com erro ${r.status}.`);
  return r.json();
}

// ---------------------------------------------------------------- Impressão
/** Imprime um HTML na impressora escolhida, sem diálogo. Devolve quando terminar. */
function printHtml(html, copies = 1, paperMm = 80) {
  return new Promise((resolve, reject) => {
    const w = new BrowserWindow({ show: false, width: 420, height: 900, webPreferences: { sandbox: true, javascript: true } }); // o cupom desenha o QR code com JavaScript
    const file = path.join(app.getPath('temp'), `feliz-cupom-${Date.now()}.html`);
    fs.writeFileSync(file, html, 'utf8');
    const cleanup = () => { try { fs.unlinkSync(file); } catch (e) {} if (!w.isDestroyed()) w.destroy(); };
    w.webContents.once('did-finish-load', async () => {
      try {
        // Altura real do cupom para o rolo da térmica não cortar nem sobrar papel
        const px = await w.webContents.executeJavaScript('Math.ceil(document.documentElement.scrollHeight)', true).catch(() => 1200);
        const opts = {
          silent: true,
          printBackground: true,
          deviceName: config.printer || undefined,
          copies: Math.max(1, Math.min(5, copies)),
          margins: { marginType: 'none' },
          pageSize: { width: paperMm * 1000, height: Math.max(100000, Math.round(px * 264.583)) },
        };
        w.webContents.print(opts, (ok, reason) => {
          cleanup();
          ok ? resolve() : reject(new Error(reason || 'A impressora não respondeu.'));
        });
      } catch (e) {
        cleanup();
        reject(e);
      }
    });
    w.webContents.once('did-fail-load', () => { cleanup(); reject(new Error('Não foi possível montar o cupom.')); });
    w.loadFile(file);
  });
}

// ---------------------------------------------------------------- Fila
async function tick() {
  if (busy || !config.site || !config.key) return;
  busy = true;
  try {
    const job = await api('next', { extra: '&format=html' });
    if (!state.online) setState({ online: true, message: 'Conectado. Aguardando pedidos…' });
    if (job && job.job) {
      addLog(`Imprimindo o pedido ${job.code}…`);
      await printHtml(job.html, job.copies || config.copies, job.paper || 80);
      await api('done', { method: 'POST', extra: `&job=${job.job}` });
      setState({ last: `${job.code} às ${new Date().toLocaleTimeString('pt-BR').slice(0, 5)}`, printed: state.printed + 1, message: 'Conectado. Aguardando pedidos…' });
      addLog(`Pedido ${job.code} impresso ✓`, 'ok');
      if (config.notify && Notification.isSupported()) {
        new Notification({ title: 'Pedido impresso', body: `${job.code} saiu na impressora.`, silent: true }).show();
      }
      busy = false;
      return tick(); // pode haver mais na fila
    }
  } catch (e) {
    if (state.online || state.message !== e.message) addLog(e.message, 'error');
    setState({ online: false, message: e.message });
  }
  busy = false;
}
function startLoop() {
  clearInterval(timer);
  timer = setInterval(tick, Math.max(3, Number(config.every) || 5) * 1000);
  tick();
}

// ---------------------------------------------------------------- Janela e bandeja
function icon(name) {
  return nativeImage.createFromPath(path.join(__dirname, 'assets', name));
}
function openWindow() {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 520, height: 720, resizable: false, maximizable: false, title: 'Feliz Cristais Impressora',
    icon: icon('icon.png'), autoHideMenuBar: true, backgroundColor: '#1d1610',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'settings.html'));
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide(); // continua rodando na bandeja
    }
  });
}
function updateTray() {
  if (!tray) return;
  tray.setToolTip(`Feliz Cristais Impressora · ${state.online ? 'conectada' : 'desconectada'}${state.last ? ' · último: ' + state.last : ''}`);
  tray.setImage(icon(state.online ? 'tray.png' : 'tray-off.png'));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: state.online ? '● Conectada à loja' : '○ Desconectada', enabled: false },
    { label: state.last ? `Último: ${state.last}` : 'Nenhum pedido impresso ainda', enabled: false },
    { type: 'separator' },
    { label: 'Abrir configurações', click: openWindow },
    { label: 'Imprimir teste', click: () => printSample().catch((e) => addLog(e.message, 'error')) },
    { label: 'Procurar atualizações', click: () => checkUpdates(true) },
    { type: 'separator' },
    { label: 'Sair (para de imprimir)', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}
async function printSample() {
  const d = await api('sample');
  if (!d || !d.html) throw new Error('Ainda não há pedidos no site para imprimir um teste.');
  await printHtml(d.html, 1, d.paper || 80);
  addLog('Teste impresso ✓', 'ok');
}

function applyAutostart() {
  app.setLoginItemSettings({ openAtLogin: !!config.autostart, openAsHidden: true, args: ['--hidden'] });
}

// ---------------------------------------------------------------- Atualização automática (GitHub)
function checkUpdates(manual = false) {
  if (!app.isPackaged) {
    if (manual) addLog('Atualização automática funciona só na versão instalada.');
    return;
  }
  autoUpdater.checkForUpdates().catch((e) => manual && addLog('Não foi possível procurar atualizações: ' + e.message, 'error'));
}
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.on('update-available', (i) => addLog(`Nova versão ${i.version} encontrada. Baixando…`));
autoUpdater.on('update-not-available', () => addLog(`Você está na versão mais nova (${app.getVersion()}).`));
autoUpdater.on('update-downloaded', (i) => {
  addLog(`Versão ${i.version} pronta. Instalando…`, 'ok');
  // Instala sem atrapalhar: espera não haver impressão em andamento
  const go = () => (busy ? setTimeout(go, 3000) : (app.isQuitting = true, autoUpdater.quitAndInstall(true, true)));
  setTimeout(go, 5000);
});
autoUpdater.on('error', (e) => addLog('Atualização: ' + (e && e.message ? e.message : e), 'error'));

// ---------------------------------------------------------------- Comunicação com a janela
ipcMain.handle('get', async () => ({ config, state, log, version: app.getVersion(), printers: await listPrinters() }));
ipcMain.handle('printers', listPrinters);
ipcMain.handle('save', async (_e, c) => {
  config = { ...config, ...c, copies: Math.max(1, Math.min(5, Number(c.copies) || 1)), every: Math.max(3, Math.min(60, Number(c.every) || 5)) };
  saveConfig();
  applyAutostart();
  setState({ online: false, message: 'Conectando…' });
  try {
    const p = await api('ping');
    setState({ online: true, message: `Conectado à ${p.store}. Aguardando pedidos…` });
    addLog(`Conectado à ${p.store} ✓`, 'ok');
  } catch (e) {
    setState({ online: false, message: e.message });
    addLog(e.message, 'error');
  }
  startLoop();
  return { config, state };
});
ipcMain.handle('test', async () => {
  try {
    await printSample();
    return { ok: true };
  } catch (e) {
    addLog(e.message, 'error');
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('update', () => checkUpdates(true));
ipcMain.handle('open', (_e, url) => /^https?:\/\//.test(url) && shell.openExternal(url));

async function listPrinters() {
  const w = win && !win.isDestroyed() ? win : new BrowserWindow({ show: false });
  const list = await w.webContents.getPrintersAsync();
  if (w !== win) w.destroy();
  return list.map((p) => ({ name: p.name, label: p.displayName || p.name, isDefault: !!p.isDefault }));
}

// ---------------------------------------------------------------- Arquivo de configuração (.fcprint)
/** Lê o arquivo gerado no painel da loja (Impressão de pedidos) e já conecta. */
async function importConfigFile(file, quiet = false) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (d.tipo !== 'feliz-cristais-impressora' || !d.site || !d.chave) throw new Error('Este arquivo não é uma configuração da Feliz Cristais Impressora.');
    config = { ...config, site: String(d.site), key: String(d.chave), copies: Math.max(1, Math.min(5, Number(d.vias) || config.copies)) };
    saveConfig();
    addLog(`Configuração de ${d.loja || 'loja'} importada ✓`, 'ok');
    setState({ online: false, message: 'Conectando…' });
    try {
      const p = await api('ping');
      setState({ online: true, message: `Conectado à ${p.store}. Aguardando pedidos…` });
      addLog(`Conectado à ${p.store} ✓`, 'ok');
      if (!quiet && Notification.isSupported()) new Notification({ title: 'Impressora configurada', body: `Conectada à ${p.store}. Escolha a impressora e faça um teste.` }).show();
    } catch (e) {
      setState({ online: false, message: e.message });
      addLog(e.message, 'error');
    }
    send('config', config);
    startLoop();
    return { ok: true, config, state };
  } catch (e) {
    addLog(e.message.startsWith('Este arquivo') ? e.message : 'Não foi possível ler o arquivo de configuração.', 'error');
    return { ok: false, error: e.message };
  }
}
/** Arquivo .fcprint recebido pela linha de comando (dois cliques no arquivo, no Windows). */
function fileFromArgs(argv) {
  return (argv || []).find((a) => /\.fcprint$/i.test(a) && fs.existsSync(a));
}
/** Primeira vez: procura o arquivo na pasta Downloads (o mais recente) e configura sozinho. */
function findInDownloads() {
  try {
    const dir = app.getPath('downloads');
    const files = fs.readdirSync(dir).filter((f) => /^feliz-impressora.*\.fcprint$/i.test(f))
      .map((f) => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    return files.length ? files[0].f : null;
  } catch (e) {
    return null;
  }
}
let pendingFile = null;
app.on('open-file', (e, file) => { // Mac: dois cliques no arquivo
  e.preventDefault();
  if (app.isReady()) { openWindow(); importConfigFile(file); } else pendingFile = file;
});
ipcMain.handle('import', async (_e, file) => {
  let f = file;
  if (!f) {
    const r = await dialog.showOpenDialog(win, { title: 'Arquivo de configuração', filters: [{ name: 'Configuração da impressora', extensions: ['fcprint'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    f = r.filePaths[0];
  }
  return importConfigFile(f);
});

// ---------------------------------------------------------------- Início
app.on('second-instance', (_e, argv) => {
  openWindow();
  const f = fileFromArgs(argv);
  if (f) importConfigFile(f);
});
app.on('window-all-closed', (e) => e.preventDefault()); // continua na bandeja
app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  if (process.platform === 'win32') app.setAppUserModelId('br.com.felizcristais.impressora');
  loadConfig();
  applyAutostart();
  tray = new Tray(icon('tray-off.png'));
  tray.on('click', openWindow);
  updateTray();
  const hidden = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAsHidden;
  const file = pendingFile || fileFromArgs(process.argv) || (!config.site || !config.key ? findInDownloads() : null);
  if (!config.site || !config.key || !hidden || file) openWindow();
  if (file) importConfigFile(file, true);
  startLoop();
  checkUpdates();
  setInterval(checkUpdates, 6 * 60 * 60 * 1000); // procura atualização a cada 6 horas
});
