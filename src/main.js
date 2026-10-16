/**
 * Feliz Cristais Gestão (antigo "Feliz Cristais Impressora")
 * - Abre o painel da loja numa janela própria (o login fica guardado).
 * - Fica na bandeja do sistema (ao lado do relógio) e inicia com o computador.
 * - Avisa com notificações do sistema: pedido novo, cliente no chat, mensagem do site, agradecimentos…
 *   e mostra o número de pendências no ícone.
 * - Imprime sozinho os pedidos na impressora escolhida (fila do site, sem janela de confirmação).
 * - Se atualiza sozinho pelas versões publicadas no GitHub.
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification, shell, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { autoUpdater } = require('electron-updater');

const NAME = 'Feliz Cristais Gestão';
const PART = 'persist:painel';

// Mesma pasta de dados da versão "Impressora" (a configuração continua depois da atualização).
// Perfil separado para testes (desenvolvimento): FC_USER_DATA=pasta
app.setPath('userData', process.env.FC_USER_DATA || path.join(app.getPath('appData'), 'Feliz Cristais Impressora'));
app.setName(NAME);

// Uma cópia só (abrir de novo traz a janela da que já está rodando)
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');
const DEFAULTS = { site: '', key: '', printer: '', copies: 1, every: 5, autostart: true, notify: true, printOn: true, alerts: true, sound: true };
let config = { ...DEFAULTS };
let tray = null;
let win = null; // configurações
let panel = null; // painel da loja
let timer = null;
let alertTimer = null;
let busy = false;
let state = { online: false, message: 'Configure o endereço do site.', last: null, printed: 0 };
let alerts = { logged: null, pending: 0, orders: 0, chat: 0, unread: 0 };
let lastIds = null;
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
function icon(name) {
  return nativeImage.createFromPath(path.join(__dirname, 'assets', name));
}

// ---------------------------------------------------------------- Site
function siteBase() {
  return config.site.trim().replace(/\/+$/, '').replace(/\/admin(\/.*)?$/, '');
}
function sameSite(url) {
  try {
    return new URL(url).origin === new URL(siteBase()).origin;
  } catch (e) {
    return false;
  }
}
function apiUrl(action, extra = '') {
  return `${siteBase()}/admin/print_api.php?action=${action}&station=${encodeURIComponent(os.hostname())}${extra}`;
}
async function api(action, { method = 'GET', extra = '' } = {}) {
  const r = await fetch(apiUrl(action, extra), {
    method,
    headers: { 'X-Print-Key': config.key.trim(), 'User-Agent': `FelizCristaisImpressora/${app.getVersion()} FCGestao` },
    signal: AbortSignal.timeout(20000),
  });
  if (r.status === 204) return null;
  if (r.status === 401) throw new Error('Chave de impressão inválida. Baixe de novo o arquivo de configuração no painel (Impressão de pedidos).');
  if (!r.ok) throw new Error(`O site respondeu com erro ${r.status}. Tentando de novo…`);
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('O site está fora do ar ou em manutenção no momento. Tentando de novo…');
  }
}

// ---------------------------------------------------------------- Painel da loja
function panelSession() {
  const ses = session.fromPartition(PART);
  if (!ses.__fc) {
    ses.__fc = true;
    ses.setUserAgent(ses.getUserAgent().replace(/Electron\/\S+\s?/, '') + ` FCGestao/${app.getVersion()}`);
    // Avisos ficam com o aplicativo (notificação nativa); a página não pede permissão própria
    ses.setPermissionRequestHandler((_wc, perm, cb) => cb(['clipboard-sanitized-write', 'fullscreen', 'media'].includes(perm)));
    ses.setPermissionCheckHandler((_wc, perm) => perm !== 'notifications');
    // O painel no app não usa service worker (cache offline/push do navegador); limpa o que houver
    ses.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] }).catch(() => {});
  }
  return ses;
}
function openPanel(target) {
  if (!config.site) {
    openWindow();
    return;
  }
  const url = target ? new URL(target, siteBase() + '/').href : siteBase() + '/admin/';
  if (panel && !panel.isDestroyed()) {
    if (target) panel.loadURL(url);
    if (panel.isMinimized()) panel.restore();
    panel.show();
    panel.focus();
    return;
  }
  panelSession();
  panel = new BrowserWindow({
    width: 1340, height: 880, minWidth: 900, minHeight: 600, show: true, title: NAME,
    icon: icon('icon.png'), autoHideMenuBar: true, backgroundColor: '#FBF8F4',
    // sem corretor ortográfico (baixava dicionários e deixava a digitação lenta)
    webPreferences: { partition: PART, contextIsolation: true, sandbox: true, spellcheck: false, backgroundThrottling: true },
  });
  panel.webContents.setUserAgent(panelSession().getUserAgent());
  panel.loadURL(url);
  const wc = panel.webContents;
  // Links de fora (WhatsApp, Instagram, Mercado Pago…) abrem no navegador; janelas da loja (cupom, impressão) abrem no app
  wc.setWindowOpenHandler(({ url: u }) => {
    if (sameSite(u)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: icon('icon.png'), webPreferences: { partition: PART, sandbox: true } } };
    if (/^https?:|^mailto:|^tel:/.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, u) => {
    if (!sameSite(u)) {
      e.preventDefault();
      if (/^https?:|^mailto:|^tel:/.test(u)) shell.openExternal(u);
    }
  });
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r')) { wc.reload(); e.preventDefault(); }
    if ((input.control || input.meta) && input.key === '=') { wc.setZoomLevel(wc.getZoomLevel() + 0.5); e.preventDefault(); }
    if ((input.control || input.meta) && input.key === '-') { wc.setZoomLevel(wc.getZoomLevel() - 0.5); e.preventDefault(); }
    if ((input.control || input.meta) && input.key === '0') { wc.setZoomLevel(0); e.preventDefault(); }
    if (input.alt && input.key === 'ArrowLeft' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  });
  // Sem internet: mostra a tela de espera e tenta de novo sozinho
  let retry = null;
  wc.on('did-fail-load', (_e, code, _desc, failed, isMain) => {
    if (!isMain || code === -3) return;
    clearTimeout(retry);
    wc.loadFile(path.join(__dirname, 'offline.html'));
    retry = setTimeout(() => panel && !panel.isDestroyed() && panel.loadURL(failed || url), 15000);
  });
  wc.on('page-title-updated', () => updateTray());
  panel.on('focus', () => { panel.flashFrame(false); pollAlerts(); });
  panel.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      panel.hide(); // continua na bandeja, avisando e imprimindo
    }
  });
}

// ---------------------------------------------------------------- Avisos (notificações do sistema)
async function pollAlerts() {
  if (!config.site || !config.alerts) return;
  const q = lastIds ? `?o=${lastIds.o}&m=${lastIds.m}&c=${lastIds.c}&w=${lastIds.w}` : '';
  try {
    const r = await panelSession().fetch(`${siteBase()}/admin/notify.php${q}`, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (r.status === 401) {
      if (alerts.logged !== false) {
        alerts = { ...alerts, logged: false };
        updateTray();
        setBadge(0);
      }
      return;
    }
    const d = await r.json();
    if (!d.ok) return;
    if (lastIds && Array.isArray(d.events)) {
      d.events.slice(0, 6).reverse().forEach(showAlert);
    }
    lastIds = { o: d.last_order || 0, m: d.last_message || 0, c: d.last_chat || 0, w: d.last_wa || 0 };
    alerts = { logged: true, orders: d.new_orders || 0, chat: d.chat_waiting || 0, unread: d.unread || 0, pending: (d.new_orders || 0) + (d.chat_waiting || 0) + (d.unread || 0) };
    if (process.env.FC_DEBUG_LOG) fs.appendFileSync(process.env.FC_DEBUG_LOG, 'poll ' + JSON.stringify(alerts) + '\n');
    setBadge(alerts.pending);
    updateTray();
  } catch (e) {
    // sem conexão: tenta na próxima rodada
  }
}
function showAlert(ev) {
  if (process.env.FC_DEBUG_LOG) fs.appendFileSync(process.env.FC_DEBUG_LOG, JSON.stringify(ev) + '\n');
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: ev.title || NAME, body: ev.text || '', icon: path.join(__dirname, 'assets', 'icon.png'), silent: !config.sound });
  n.on('click', () => openPanel(ev.url));
  n.show();
  if (panel && !panel.isDestroyed() && !panel.isFocused()) panel.flashFrame(true);
}
function setBadge(n) {
  if (process.platform === 'darwin') app.setBadgeCount(n);
  if (process.platform === 'win32' && panel && !panel.isDestroyed()) panel.setOverlayIcon(n > 0 ? icon('badge.png') : null, n > 0 ? `${n} pendência(s)` : '');
}
function startAlerts() {
  clearInterval(alertTimer);
  lastIds = null;
  if (!config.alerts) return;
  alertTimer = setInterval(pollAlerts, 15000);
  pollAlerts();
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
function printReady() {
  return !!(config.printOn && config.site && config.key);
}
async function tick() {
  if (busy || !printReady()) return;
  busy = true;
  try {
    const job = await api('next', { extra: '&format=html' });
    if (!state.online) setState({ online: true, message: 'Conectada. Aguardando pedidos…' });
    if (job && job.job) {
      addLog(`Imprimindo o pedido ${job.code}…`);
      await printHtml(job.html, job.copies || config.copies, job.paper || 80);
      await api('done', { method: 'POST', extra: `&job=${job.job}` });
      setState({ last: `${job.code} às ${new Date().toLocaleTimeString('pt-BR').slice(0, 5)}`, printed: state.printed + 1, message: 'Conectada. Aguardando pedidos…' });
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
  if (!printReady()) {
    setState({ online: false, message: config.key ? 'Impressão automática desligada.' : 'Impressão: importe o arquivo de configuração para imprimir os pedidos.' });
    return;
  }
  timer = setInterval(tick, Math.max(3, Number(config.every) || 5) * 1000);
  tick();
}
async function printSample() {
  const d = await api('sample');
  if (!d || !d.html) throw new Error('Ainda não há pedidos no site para imprimir um teste.');
  await printHtml(d.html, 1, d.paper || 80);
  addLog('Teste impresso ✓', 'ok');
}

// ---------------------------------------------------------------- Janela de configurações e bandeja
function openWindow() {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 540, height: 780, resizable: false, maximizable: false, title: `${NAME} · Configurações`,
    icon: icon('icon.png'), autoHideMenuBar: true, backgroundColor: '#1d1610',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'settings.html'));
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
}
function updateTray() {
  if (!tray) return;
  const parts = [];
  if (alerts.orders) parts.push(`${alerts.orders} pedido(s) novo(s)`);
  if (alerts.chat) parts.push(`${alerts.chat} no atendimento`);
  if (alerts.unread) parts.push(`${alerts.unread} mensagem(ns)`);
  tray.setToolTip(`${NAME}${parts.length ? ' · ' + parts.join(' · ') : ''}${printReady() ? (state.online ? ' · impressora conectada' : ' · impressora desconectada') : ''}`);
  tray.setImage(icon(alerts.pending > 0 ? 'tray-alert.png' : (alerts.logged === false || (printReady() && !state.online) ? 'tray-off.png' : 'tray.png')));
  const go = (p) => () => openPanel(p);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: NAME, enabled: false },
    alerts.logged === false
      ? { label: '⚠ Entre no painel para receber os avisos', click: go() }
      : { label: parts.length ? parts.join(' · ') : 'Tudo em dia ✓', enabled: false },
    { type: 'separator' },
    { label: 'Abrir o painel', click: go(), accelerator: 'CommandOrControl+O' },
    { label: `Pedidos${alerts.orders ? ` (${alerts.orders})` : ''}`, click: go('admin/orders.php') },
    { label: `Atendimento${alerts.chat ? ` (${alerts.chat})` : ''}`, click: go('admin/chat.php') },
    { label: 'Retiradas na loja', click: go('admin/retiradas.php') },
    { label: 'Relatórios', click: go('admin/relatorios.php') },
    { type: 'separator' },
    { label: printReady() ? (state.online ? '● Impressora conectada' : '○ Impressora desconectada') : '○ Impressão automática desligada', enabled: false },
    ...(state.last ? [{ label: `Último impresso: ${state.last}`, enabled: false }] : []),
    { label: 'Imprimir teste', enabled: printReady(), click: () => printSample().catch((e) => addLog(e.message, 'error')) },
    { type: 'separator' },
    { label: 'Configurações', click: openWindow },
    { label: 'Procurar atualizações', click: () => checkUpdates(true) },
    { label: `Versão ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: 'Sair (para de avisar e imprimir)', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}
function applyAutostart() {
  if (!app.isPackaged) return; // em desenvolvimento não mexe na inicialização do computador
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
  // Instala sem atrapalhar: espera não haver impressão em andamento nem o painel em uso
  const go = () => (busy || (panel && !panel.isDestroyed() && panel.isFocused()) ? setTimeout(go, 30000) : (app.isQuitting = true, autoUpdater.quitAndInstall(true, true)));
  setTimeout(go, 5000);
});
autoUpdater.on('error', (e) => addLog('Atualização: ' + (e && e.message ? e.message : e), 'error'));

// ---------------------------------------------------------------- Comunicação com a janela de configurações
ipcMain.handle('get', async () => ({ config, state, log, version: app.getVersion(), printers: await listPrinters(), alerts }));
ipcMain.handle('printers', listPrinters);
ipcMain.handle('save', async (_e, c) => {
  const siteChanged = (c.site || '') !== config.site;
  config = { ...config, ...c, copies: Math.max(1, Math.min(5, Number(c.copies) || 1)), every: Math.max(3, Math.min(60, Number(c.every) || 5)) };
  saveConfig();
  applyAutostart();
  if (printReady()) {
    setState({ online: false, message: 'Conectando…' });
    try {
      const p = await api('ping');
      setState({ online: true, message: `Conectada à ${p.store}. Aguardando pedidos…` });
      addLog(`Impressão conectada à ${p.store} ✓`, 'ok');
    } catch (e) {
      setState({ online: false, message: e.message });
      addLog(e.message, 'error');
    }
  }
  startLoop();
  startAlerts();
  if (siteChanged && panel && !panel.isDestroyed()) panel.loadURL(siteBase() + '/admin/');
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
ipcMain.handle('panel', () => openPanel());
ipcMain.handle('open', (_e, url) => /^https?:\/\//.test(url) && shell.openExternal(url));

async function listPrinters() {
  const w = win && !win.isDestroyed() ? win : new BrowserWindow({ show: false });
  const list = await w.webContents.getPrintersAsync();
  if (w !== win) w.destroy();
  return list.map((p) => ({ name: p.name, label: p.displayName || p.name, isDefault: !!p.isDefault }));
}

// ---------------------------------------------------------------- Arquivo de configuração (.fcprint)
/** Lê o arquivo gerado no painel da loja (Impressão de pedidos), conecta a impressão e abre o painel. */
async function importConfigFile(file, quiet = false) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    if (d.tipo !== 'feliz-cristais-impressora' || !d.site || !d.chave) throw new Error('Este arquivo não é uma configuração da Feliz Cristais.');
    config = { ...config, site: String(d.site), key: String(d.chave), copies: Math.max(1, Math.min(5, Number(d.vias) || config.copies)) };
    saveConfig();
    addLog(`Configuração de ${d.loja || 'loja'} importada ✓`, 'ok');
    setState({ online: false, message: 'Conectando…' });
    try {
      const p = await api('ping');
      setState({ online: true, message: `Conectada à ${p.store}. Aguardando pedidos…` });
      addLog(`Conectado à ${p.store} ✓`, 'ok');
      if (!quiet && Notification.isSupported()) new Notification({ title: 'Tudo pronto ✨', body: `Conectado à ${p.store}. Entre no painel para receber os avisos.` }).show();
    } catch (e) {
      setState({ online: false, message: e.message });
      addLog(e.message, 'error');
    }
    send('config', config);
    startLoop();
    startAlerts();
    openPanel();
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
  if (app.isReady()) importConfigFile(file); else pendingFile = file;
});
ipcMain.handle('import', async (_e, file) => {
  let f = file;
  if (!f) {
    const r = await dialog.showOpenDialog(win, { title: 'Arquivo de configuração', filters: [{ name: 'Configuração Feliz Cristais', extensions: ['fcprint'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    f = r.filePaths[0];
  }
  return importConfigFile(f);
});

// ---------------------------------------------------------------- Início
app.on('second-instance', (_e, argv) => {
  const f = fileFromArgs(argv);
  if (f) importConfigFile(f); else openPanel();
});
app.on('activate', () => openPanel()); // Mac: clique no ícone do Dock
app.on('window-all-closed', (e) => e.preventDefault()); // continua na bandeja
app.on('before-quit', () => { app.isQuitting = true; });
app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('br.com.felizcristais.impressora');
  loadConfig();
  applyAutostart();
  tray = new Tray(icon('tray-off.png'));
  tray.on('click', () => openPanel());
  updateTray();
  const hidden = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAsHidden;
  const file = pendingFile || fileFromArgs(process.argv) || (!config.site ? findInDownloads() : null);
  if (file) {
    importConfigFile(file, true);
  } else if (!config.site) {
    openWindow();
  } else if (!hidden) {
    openPanel();
  }
  startLoop();
  startAlerts();
  checkUpdates();
  setInterval(checkUpdates, 6 * 60 * 60 * 1000); // procura atualização a cada 6 horas
});
