/**
 * Feliz Cristais Gestão (antigo "Feliz Cristais Impressora")
 * - Abre o painel da loja numa janela própria (o login fica guardado).
 * - Fica na bandeja do sistema (ao lado do relógio) e inicia com o computador.
 * - Avisa com notificações do sistema: pedido novo, cliente no chat, mensagem do site, agradecimentos…
 *   e mostra o número de pendências no ícone.
 * - Imprime sozinho os pedidos na impressora escolhida (fila do site, sem janela de confirmação).
 * - Se atualiza sozinho pelas versões publicadas no GitHub.
 */
const { app, BrowserWindow, WebContentsView, Tray, Menu, ipcMain, nativeImage, Notification, shell, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { autoUpdater } = require('electron-updater');
const Offline = require('./offline');

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
  if (settingsView && !settingsView.webContents.isDestroyed()) settingsView.webContents.send(channel, data);
}
function setState(patch) {
  const was = state.online;
  state = { ...state, ...patch };
  send('state', state);
  updateTray();
  if (was !== state.online && panel && !panel.isDestroyed() && typeof panelMenu === 'function') panel.setMenu(panelMenu());
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
    // Login guardado entre aberturas do app: o cookie de sessão da loja passa a durar 12 horas (igual ao servidor)
    ses.cookies.on('changed', (_e, c, _cause, removed) => {
      if (removed || !c.session || c.name !== 'fcsess' || !config.site) return;
      ses.cookies.set({ url: siteBase(), name: c.name, value: c.value, path: c.path, domain: c.hostOnly ? undefined : c.domain, httpOnly: c.httpOnly, secure: c.secure,
        sameSite: c.sameSite, expirationDate: Math.floor(Date.now() / 1000) + 12 * 3600 })
        .then(() => ses.cookies.flushStore())
        .catch((err) => process.env.FC_DEBUG_LOG && fs.appendFileSync(process.env.FC_DEBUG_LOG, 'cookie: ' + err.message + '\n'));
    });
    // O painel no app não usa service worker (cache offline/push do navegador); limpa o que houver
    ses.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] }).catch(() => {});
    // Modo offline: cópia local do que foi aberto + carga do que for salvo sem internet
    off = Offline.create({
      session: ses, userData: app.getPath('userData'), siteBase,
      offlinePage: () => fs.readFileSync(path.join(__dirname, 'offline.html'), 'utf8')
        .replace('Sem conexão com a loja', 'Sem internet')
        .replace(/<p>[\s\S]*?<\/p>/, '<p>Esta página ainda não foi aberta com internet neste computador. As páginas que você já abriu continuam disponíveis; o que você salvar fica guardado no app e é enviado quando a conexão voltar.</p>'),
      onState: (on, pending) => {
        updateTray();
        if (on) {
          panelToast({ title: 'Internet de volta', text: pending ? `Enviando ${pending} alteração(ões) guardada(s) no app…` : 'O painel está atualizado com a loja.', type: 'online' });
          removeBanner();
        } else {
          panelToast({ title: 'Sem internet', text: 'O app continua funcionando com os dados salvos. O que você salvar fica guardado e é enviado quando a conexão voltar.', type: 'offline', duration: 9000 });
          showBanner();
          if (!panel || panel.isDestroyed() || !panel.isFocused()) notify('Sem internet', 'O app continua com os dados salvos e envia suas alterações quando a conexão voltar.');
        }
      },
      onQueued: (n, nav) => {
        updateTray();
        const t = { title: 'Guardado no app', text: `Sem internet: a alteração foi guardada (${n} na fila) e será enviada ao sistema quando a conexão voltar.`, type: 'queued', duration: 8000 };
        if (nav && panel && !panel.isDestroyed()) panel.webContents.once('did-finish-load', () => setTimeout(() => panelToast(t), 200)); else panelToast(t);
      },
      onSynced: (sent, failed, left) => {
        updateTray();
        if (sent || failed) {
          const t = { title: sent ? 'Carga enviada' : 'Carga com problemas', text: `${sent} alteração(ões) feita(s) sem internet gravada(s) no sistema${failed ? ` · ${failed} recusada(s) pelo servidor (confira os dados)` : ''}${left ? ` · ${left} aguardando` : ''}.`, type: failed ? 'warn' : 'sync', duration: 9000 };
          if (sent && panel && !panel.isDestroyed()) {
            panel.webContents.once('did-finish-load', () => setTimeout(() => panelToast(t), 300));
            panel.webContents.reload(); // mostra os dados já atualizados
          } else panelToast(t);
          if (!panel || panel.isDestroyed() || !panel.isFocused()) notify('Alterações enviadas', `${sent} alteração(ões) feitas sem internet foram gravadas no sistema.`);
        }
      },
    });
  }
  return ses;
}
let off = null;
let precached = false;
/** Notificação do sistema (app em segundo plano). */
function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, icon: path.join(__dirname, 'assets', 'icon.png'), silent: true }).show();
}
/** Faixa no topo do painel enquanto estiver sem internet. */
function showBanner() {
  if (!panel || panel.isDestroyed() || !off || off.isOnline()) return;
  const n = off.pending();
  const js = `(function(){var b=document.getElementById('fc-off');if(!b){b=document.createElement('div');b.id='fc-off';
    b.style.cssText='position:fixed;left:0;right:0;bottom:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;gap:10px;padding:9px 14px;font:600 13px/1.3 -apple-system,Segoe UI,Roboto,sans-serif;color:#5a3d00;background:linear-gradient(90deg,#ffe3a3,#ffd27a);box-shadow:0 -6px 20px -10px rgba(0,0,0,.35)';
    document.body.appendChild(b);}b.innerHTML='<span style="width:9px;height:9px;border-radius:50%;background:#e08600;box-shadow:0 0 0 4px rgba(224,134,0,.25)"></span>Sem internet · usando os dados salvos no computador${n ? ` · ${n} alteração(ões) aguardando envio` : ''}';})()`;
  panel.webContents.executeJavaScript(js).catch(() => {});
}
function removeBanner() {
  if (panel && !panel.isDestroyed()) panel.webContents.executeJavaScript("var b=document.getElementById('fc-off');if(b)b.remove()").catch(() => {});
}
/** Páginas do painel guardadas para usar sem internet (depois do login). */
function precachePanel() {
  if (precached || !off || !off.isOnline()) return;
  precached = true;
  setTimeout(() => off.precache(['admin/', 'admin/orders.php', 'admin/retiradas.php', 'admin/chat.php', 'admin/crm.php', 'admin/fidelidade.php',
    'admin/cupons.php', 'admin/relatorios.php', 'admin/analise.php?aba=produtos', 'admin/ofertas.php', 'admin/impressao.php', 'admin/crud.php?e=products',
    'admin/crud.php?e=categories', 'admin/messages.php', 'admin/settings.php']), 20000);
}
// ---------------------------------------------------------------- Splash de abertura
let splash = null;
function openSplash() {
  splash = new BrowserWindow({
    width: 440, height: 330, frame: false, transparent: true, resizable: false, movable: true, skipTaskbar: false,
    alwaysOnTop: true, show: false, center: true, title: NAME, icon: icon('icon.png'), hasShadow: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  splash.loadFile(path.join(__dirname, 'splash.html'), { query: { v: app.getVersion() } });
  splash.once('ready-to-show', () => splash && !splash.isDestroyed() && splash.show());
  splash.on('closed', () => { splash = null; });
  splash.__opened = Date.now();
  setTimeout(closeSplash, 15000); // nunca fica preso na tela
}
function closeSplash() {
  if (!splash || splash.isDestroyed()) return;
  const s = splash;
  const wait = Math.max(0, 1400 - (Date.now() - s.__opened)); // tempo mínimo para a animação não "piscar"
  setTimeout(() => {
    if (s.isDestroyed()) return;
    s.webContents.executeJavaScript("document.body.classList.add('out')").catch(() => {});
    setTimeout(() => !s.isDestroyed() && s.destroy(), 330);
    if (panel && !panel.isDestroyed() && !panel.isVisible()) { panel.show(); panel.focus(); }
  }, wait);
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
    width: 1340, height: 880, minWidth: 900, minHeight: 600, show: !(splash && !splash.isDestroyed()), title: NAME,
    icon: icon('icon.png'), autoHideMenuBar: false, backgroundColor: '#FBF8F4',
    // sem corretor ortográfico (baixava dicionários e deixava a digitação lenta)
    webPreferences: { partition: PART, contextIsolation: true, sandbox: true, spellcheck: false, backgroundThrottling: true },
  });
  panel.webContents.setUserAgent(panelSession().getUserAgent());
  panel.setMenu(panelMenu());
  panel.webContents.once('did-finish-load', closeSplash);
  panel.webContents.once('did-fail-load', closeSplash);
  panel.loadURL(url);
  const wc = panel.webContents;
  // Links de fora (WhatsApp, Instagram, Mercado Pago…) abrem no navegador; janelas da loja (cupom, impressão) abrem no app
  wc.setWindowOpenHandler(({ url: u }) => {
    if (sameSite(u) && /\/admin\//.test(new URL(u).pathname)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: icon('icon.png'), webPreferences: { partition: PART, sandbox: true } } };
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
  // Página travou (ex.: falta de memória): recarrega sozinha em vez de ficar branca
  wc.on('render-process-gone', (_e, d) => { if (d.reason !== 'clean-exit') setTimeout(() => !wc.isDestroyed() && wc.reload(), 800); });
  wc.on('did-finish-load', () => { if (off && !off.isOnline()) showBanner(); });
  wc.on('did-fail-load', (_e, code, _desc, failed, isMain) => {
    if (!isMain || code === -3) return;
    clearTimeout(retry);
    if (off) {
      // Sem internet: liga o modo offline e abre a cópia guardada da página
      off.failed(code);
      if (!off.isOnline()) {
        retry = setTimeout(() => panel && !panel.isDestroyed() && panel.loadURL(failed || url), 300);
        return;
      }
    }
    wc.loadFile(path.join(__dirname, 'offline.html'));
    retry = setTimeout(() => panel && !panel.isDestroyed() && panel.loadURL(failed || url), 15000);
  });
  wc.on('page-title-updated', () => updateTray());
  panel.on('focus', () => { panel.flashFrame(false); pollAlerts(); });
  panel.webContents.on('did-start-navigation', (_e, _u, inPlace, isMain) => { if (isMain && !inPlace && settingsView) closeSettings(); });
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
    precachePanel();
    alerts = { logged: true, orders: d.new_orders || 0, chat: d.chat_waiting || 0, unread: d.unread || 0, pending: (d.new_orders || 0) + (d.chat_waiting || 0) + (d.unread || 0) };
    if (process.env.FC_DEBUG_LOG) fs.appendFileSync(process.env.FC_DEBUG_LOG, 'poll ' + JSON.stringify(alerts) + '\n');
    setBadge(alerts.pending);
    updateTray();
  } catch (e) {
    if (off && off.isOnline()) off.check(); // confere se caiu a internet
  }
}
function showAlert(ev) {
  if (process.env.FC_DEBUG_LOG) fs.appendFileSync(process.env.FC_DEBUG_LOG, JSON.stringify(ev) + '\n');
  if (panel && !panel.isDestroyed() && panel.isVisible() && panel.isFocused() && alerts.logged) return; // o painel mostra o toast
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
  win.setMenu(null);
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
    ...(off && !off.isOnline() ? [{ label: '⚠ Sem internet · usando os dados salvos', enabled: false }] : []),
    ...(off && off.pending() ? [{ label: `⬆ Enviar ${off.pending()} alteração(ões) guardada(s)`, click: () => off.sync() }] : []),
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
    { label: 'Configurações da impressora', click: openSettings },
    ...(['available', 'downloading', 'ready'].includes(upd.state) ? [{ label: upd.state === 'ready' ? `⬆ Versão ${upd.version} pronta: reiniciar e instalar` : upd.state === 'downloading' ? `⬇ Baixando a versão ${upd.version}…` : `⬆ Nova versão ${upd.version} disponível`, click: openUpdateWindow }] : []),
    { label: 'Procurar atualizações', click: () => checkUpdates(true) },
    { label: 'Suporte e contato do desenvolvedor', click: openAbout },
    { label: `Versão ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: 'Sair (para de avisar e imprimir)', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}
function applyAutostart() {
  if (!app.isPackaged) return; // em desenvolvimento não mexe na inicialização do computador
  app.setLoginItemSettings({ openAtLogin: !!config.autostart, openAsHidden: true, args: ['--hidden'] });
}

// ---------------------------------------------------------------- Atualização (GitHub) com tela própria
// Versão nova: abre a tela com o changelog → "Instalar agora" (barra de progresso do download) ou "Lembrar mais tarde".
const REPO = 'JEAN-ALMEIDA-CZO/feliz-cristais-impressora';
let upd = { state: 'idle', version: null, date: null, notes: [], progress: null, error: null, manual: false };
let updWin = null;

function checkUpdates(manual = false) {
  if (!app.isPackaged && process.env.FC_UPD_DEMO) return updDemo(); // simulação para testar a tela (desenvolvimento)
  if (!app.isPackaged) {
    if (manual) {
      addLog('Atualização automática funciona só na versão instalada.');
      upd = { ...upd, state: 'dev', manual: true };
      openUpdateWindow();
    }
    return;
  }
  if (['downloading', 'ready'].includes(upd.state)) {
    if (manual) openUpdateWindow();
    return;
  }
  upd.manual = manual;
  if (manual) {
    upd = { ...upd, state: 'checking', error: null };
    openUpdateWindow();
  }
  autoUpdater.checkForUpdates().catch((e) => {
    if (manual) {
      upd = { ...upd, state: 'error', error: 'Não foi possível procurar atualizações: ' + (e.message || e) };
      sendUpd();
    }
  });
}
autoUpdater.autoDownload = false; // só baixa quando a pessoa escolher "Instalar agora"
autoUpdater.autoInstallOnAppQuit = true;

/** Compara versões: "2.1.0" é mais nova que "2.0.3". */
function newer(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}
/** Markdown simples (títulos, listas, negrito, código) para HTML seguro. */
function md(text) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1');
  let html = '';
  let list = false;
  for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*[-*•]\s+(.*)$/);
    if (li) {
      if (!list) { html += '<ul>'; list = true; }
      html += `<li>${inline(li[1])}</li>`;
      continue;
    }
    if (list) { html += '</ul>'; list = false; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) html += `<h4>${inline(h[2])}</h4>`;
    else if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  return list ? html + '</ul>' : html;
}
/** Changelog: versões publicadas depois da instalada (GitHub Releases), da mais nova para a mais antiga. */
async function releaseNotes(info, from = app.getVersion()) {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `FCGestao/${app.getVersion()}` }, signal: AbortSignal.timeout(15000),
    });
    if (r.ok) {
      const list = (await r.json()).filter((x) => !x.draft && newer(String(x.tag_name).replace(/^v/, ''), from));
      const own = typeof info.releaseNotes === 'string' ? md(info.releaseNotes.replace(/<[^>]+>/g, '')) : '';
      const notes = list.map((x) => ({ version: String(x.tag_name).replace(/^v/, ''), date: x.published_at, html: md(x.body) }))
        .filter((n) => !newer(n.version, info.version))
        .map((n) => (!n.html && n.version === info.version && own ? { ...n, html: own } : n)); // descrição vazia no GitHub: usa as notas da atualização
      if (notes.length) return notes;
    }
  } catch (e) {
    // sem acesso à API: usa as notas que vieram com a atualização
  }
  const rn = info.releaseNotes;
  if (Array.isArray(rn)) return rn.map((n) => ({ version: n.version, date: null, html: md(String(n.note || '').replace(/<[^>]+>/g, '')) }));
  return [{ version: info.version, date: info.releaseDate, html: rn ? md(String(rn).replace(/<[^>]+>/g, '')) : '' }];
}
function sendUpd() {
  if (updWin && !updWin.isDestroyed()) updWin.webContents.send('upd', { ...upd, current: app.getVersion() });
  updateTray();
}
function openUpdateWindow() {
  if (updWin && !updWin.isDestroyed()) {
    sendUpd();
    updWin.show();
    updWin.focus();
    return;
  }
  updWin = new BrowserWindow({
    width: 560, height: 660, minWidth: 460, minHeight: 480, title: `${NAME} · Atualização`, icon: icon('icon.png'),
    autoHideMenuBar: true, backgroundColor: '#1d1610', show: false, maximizable: false,
    webPreferences: { preload: path.join(__dirname, 'update-preload.js'), contextIsolation: true, sandbox: true },
  });
  updWin.setMenu(null);
  updWin.loadFile(path.join(__dirname, 'update.html'));
  updWin.once('ready-to-show', () => { updWin.show(); updWin.focus(); });
  updWin.on('closed', () => { updWin = null; });
}
autoUpdater.on('update-available', async (i) => {
  addLog(`Nova versão ${i.version} disponível.`);
  upd = { ...upd, state: 'available', version: i.version, date: i.releaseDate, notes: await releaseNotes(i), error: null };
  const snooze = config.updSnooze || {};
  const snoozed = snooze.version === i.version && snooze.until > Date.now();
  if (upd.manual || !snoozed) openUpdateWindow();
  sendUpd();
});
autoUpdater.on('update-not-available', () => {
  addLog(`Você está na versão mais nova (${app.getVersion()}).`);
  if (upd.manual) {
    upd = { ...upd, state: 'latest' };
    sendUpd();
  }
});
autoUpdater.on('download-progress', (p) => {
  upd = { ...upd, state: 'downloading', progress: { percent: p.percent, transferred: p.transferred, total: p.total, speed: p.bytesPerSecond } };
  if (updWin && !updWin.isDestroyed()) {
    updWin.setProgressBar(Math.max(0, Math.min(1, p.percent / 100)));
    updWin.webContents.send('upd', { ...upd, current: app.getVersion() });
  }
  if (tray) tray.setToolTip(`${NAME} · baixando a versão ${upd.version}: ${Math.round(p.percent)}%`);
});
autoUpdater.on('update-downloaded', (i) => {
  addLog(`Versão ${i.version} baixada e pronta para instalar.`, 'ok');
  upd = { ...upd, state: 'ready', progress: { ...(upd.progress || {}), percent: 100 } };
  if (updWin && !updWin.isDestroyed()) updWin.setProgressBar(-1);
  openUpdateWindow();
  sendUpd();
});
autoUpdater.on('error', (e) => {
  const msg = e && e.message ? e.message : String(e);
  addLog('Atualização: ' + msg, 'error');
  if (upd.state === 'downloading' || upd.manual) {
    upd = { ...upd, state: 'error', error: 'Não foi possível concluir a atualização. Verifique a internet e tente de novo.' };
    if (updWin && !updWin.isDestroyed()) updWin.setProgressBar(-1);
    sendUpd();
  }
});
/** Desenvolvimento: simula versão nova, download e "pronto para instalar" (FC_UPD_DEMO=1). */
async function updDemo() {
  const version = process.env.FC_UPD_DEMO.includes('.') ? process.env.FC_UPD_DEMO : '9.9.9';
  upd = { ...upd, state: 'available', version, date: new Date().toISOString(), notes: await releaseNotes({ version, releaseNotes: '' }, process.env.FC_UPD_FROM || '1.0.0'), error: null };
  openUpdateWindow();
  sendUpd();
  autoUpdater.downloadUpdate = async () => {
    const total = 82 * 1048576;
    for (let p = 0; p <= 100; p += 4) {
      await new Promise((r) => setTimeout(r, 180));
      autoUpdater.emit('download-progress', { percent: p, transferred: total * p / 100, total, bytesPerSecond: 6.4 * 1048576 });
    }
    autoUpdater.emit('update-downloaded', { version });
  };
}
ipcMain.handle('upd:get', () => ({ ...upd, current: app.getVersion() }));
ipcMain.handle('upd:download', () => {
  if (upd.state !== 'available' && upd.state !== 'error') return;
  upd = { ...upd, state: 'downloading', progress: { percent: 0, transferred: 0, total: 0, speed: 0 }, error: null };
  sendUpd();
  autoUpdater.downloadUpdate().catch(() => {});
});
ipcMain.handle('upd:later', () => {
  config.updSnooze = { version: upd.version, until: Date.now() + 4 * 60 * 60 * 1000 }; // lembra de novo em 4 horas
  saveConfig();
  addLog(`Atualização ${upd.version}: lembrar mais tarde.`);
  if (updWin && !updWin.isDestroyed()) updWin.close();
});
ipcMain.handle('upd:restart', () => {
  if (!app.isPackaged) { addLog('Simulação: aqui o app reiniciaria e instalaria.'); return; }
  // Espera terminar uma impressão em andamento
  const go = () => (busy ? setTimeout(go, 1500) : (app.isQuitting = true, autoUpdater.quitAndInstall(true, true)));
  go();
});
ipcMain.handle('upd:check', () => checkUpdates(true));
ipcMain.handle('upd:close', () => updWin && !updWin.isDestroyed() && updWin.close());

// ---------------------------------------------------------------- Toast dentro do painel, login e configurações em lightbox
/** Mostra o toast com a logo da loja dentro da janela do painel (o mesmo do site). */
function panelToast(o) {
  if (!panel || panel.isDestroyed()) return;
  const wc = panel.webContents;
  const run = () => wc.executeJavaScript(`window.FCToast ? FCToast.show(${JSON.stringify(o)}) : null`).catch(() => {});
  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 150)); else run();
}
/** Confere se a equipe está logada no painel (sessão do app). */
async function isLogged() {
  if (!config.site) return false;
  try {
    const r = await panelSession().fetch(`${siteBase()}/admin/notify.php`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    alerts.logged = r.status !== 401;
    return alerts.logged;
  } catch (e) {
    return alerts.logged !== false; // sem internet: deixa tentar abrir
  }
}
/** Itens do menu: só abre a página com login; sem login, mostra o aviso e a tela de entrar. */
async function openSecure(p) {
  if (!config.site) {
    openSettings();
    return;
  }
  if (await isLogged()) {
    openPanel(p);
    return;
  }
  const onLogin = panel && !panel.isDestroyed() && /\/admin\/login/.test(panel.webContents.getURL());
  if (!onLogin) openPanel('admin/login.php'); else openPanel();
  panelToast({ title: 'Faça login para continuar', text: 'Entre com seu e-mail e senha do painel para abrir esta área.', type: 'warn', duration: 6000 });
  updateTray();
}

let settingsView = null;
let settingsFit = null;
/** Configurações da impressora: lightbox dentro da janela do painel (sem painel aberto, janela própria). */
function openSettings() {
  if (!panel || panel.isDestroyed() || !panel.isVisible() || !WebContentsView) {
    openWindow();
    return;
  }
  if (panel.isMinimized()) panel.restore();
  panel.focus();
  if (settingsView) {
    settingsView.webContents.focus();
    return;
  }
  settingsView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true } });
  settingsView.setBackgroundColor('#00000000');
  panel.contentView.addChildView(settingsView);
  settingsFit = () => {
    if (!settingsView || panel.isDestroyed()) return;
    const [w, h] = panel.getContentSize();
    settingsView.setBounds({ x: 0, y: 0, width: w, height: h });
  };
  settingsFit();
  panel.on('resize', settingsFit);
  settingsView.webContents.loadFile(path.join(__dirname, 'settings.html'), { query: { lightbox: '1' } });
  settingsView.webContents.once('did-finish-load', () => settingsView && settingsView.webContents.focus());
}
function closeSettings() {
  if (!settingsView) return;
  const v = settingsView;
  settingsView = null;
  if (panel && !panel.isDestroyed()) {
    panel.removeListener('resize', settingsFit);
    panel.contentView.removeChildView(v);
    panel.webContents.focus();
  }
  if (!v.webContents.isDestroyed()) v.webContents.close();
}
ipcMain.handle('settings:close', (e) => {
  if (settingsView && e.sender === settingsView.webContents) closeSettings();
  else if (win && !win.isDestroyed()) win.close();
});

// ---------------------------------------------------------------- Menu da janela do painel e tela Suporte/Sobre
const DEV = {
  name: 'Jean Almeida',
  links: {
    github: 'https://github.com/JEAN-ALMEIDA-CZO',
    portfolio: 'https://portifolio.athos.app.br',
    linkedin: 'https://www.linkedin.com/in/jeanc-almeida',
    instagram: 'https://www.instagram.com/jean.almeida.czo/',
    whatsapp: 'https://wa.me/5547997804703?text=' + encodeURIComponent('Olá, Jean! Preciso de suporte no app Feliz Cristais Gestão.'),
  },
};
let aboutWin = null;
function openAbout() {
  if (aboutWin && !aboutWin.isDestroyed()) {
    aboutWin.show();
    aboutWin.focus();
    return;
  }
  aboutWin = new BrowserWindow({
    width: 460, height: 600, resizable: false, maximizable: false, minimizable: false, title: `${NAME} · Suporte`,
    icon: icon('icon.png'), backgroundColor: '#1d1610', show: false,
    webPreferences: { preload: path.join(__dirname, 'about-preload.js'), contextIsolation: true, sandbox: true },
  });
  aboutWin.setMenu(null);
  aboutWin.loadFile(path.join(__dirname, 'about.html'));
  aboutWin.once('ready-to-show', () => aboutWin.show());
  aboutWin.on('closed', () => { aboutWin = null; });
}
ipcMain.handle('about:show', () => openAbout());
ipcMain.handle('about:get', () => ({ version: app.getVersion(), dev: DEV.name, store: siteBase() }));
ipcMain.handle('about:open', (_e, key) => DEV.links[key] && shell.openExternal(DEV.links[key]));

function panelMenu() {
  const go = (p) => () => openSecure(p);
  const wc = () => (panel && !panel.isDestroyed() ? panel.webContents : null);
  return Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: NAME, submenu: [{ label: `Sobre o ${NAME}`, click: openAbout }, { type: 'separator' }, { role: 'hide', label: 'Ocultar' }, { type: 'separator' }, { label: 'Sair', accelerator: 'Cmd+Q', click: () => { app.isQuitting = true; app.quit(); } }] }] : []),
    {
      label: 'Painel',
      submenu: [
        { label: 'Início', accelerator: 'CmdOrCtrl+H', click: go('admin/') },
        { label: 'Pedidos', accelerator: 'CmdOrCtrl+1', click: go('admin/orders.php') },
        { label: 'Atendimento', accelerator: 'CmdOrCtrl+2', click: go('admin/chat.php') },
        { label: 'Retiradas na loja', accelerator: 'CmdOrCtrl+3', click: go('admin/retiradas.php') },
        { label: 'Clientes (CRM)', accelerator: 'CmdOrCtrl+4', click: go('admin/crm.php') },
        { label: 'Relatórios', accelerator: 'CmdOrCtrl+5', click: go('admin/relatorios.php') },
        { type: 'separator' },
        { label: 'Ver o site da loja', click: () => shell.openExternal(siteBase() + '/') },
        { type: 'separator' },
        { label: 'Fechar janela (continua ao lado do relógio)', accelerator: 'CmdOrCtrl+W', click: () => panel && panel.close() },
        { label: 'Sair do app', click: () => { app.isQuitting = true; app.quit(); } },
      ],
    },
    {
      label: 'Impressora',
      submenu: [
        { label: 'Configurações da impressora…', accelerator: 'CmdOrCtrl+,', click: openSettings },
        { label: 'Imprimir teste', click: () => printSample().catch((e) => { addLog(e.message, 'error'); dialog.showMessageBox(panel, { type: 'warning', title: 'Impressão', message: e.message }); }) },
        { label: 'Fila e status no painel', click: go('admin/impressao.php') },
        { type: 'separator' },
        { label: printReady() ? (state.online ? '● Impressora conectada' : '○ Impressora desconectada') : '○ Impressão automática desligada', enabled: false },
      ],
    },
    {
      label: 'Exibir',
      submenu: [
        { label: 'Recarregar', accelerator: 'F5', click: () => wc() && wc().reload() },
        { label: 'Voltar', accelerator: 'Alt+Left', click: () => wc() && wc().navigationHistory.canGoBack() && wc().navigationHistory.goBack() },
        { type: 'separator' },
        { label: 'Aumentar zoom', accelerator: 'CmdOrCtrl+=', click: () => wc() && wc().setZoomLevel(wc().getZoomLevel() + 0.5) },
        { label: 'Diminuir zoom', accelerator: 'CmdOrCtrl+-', click: () => wc() && wc().setZoomLevel(wc().getZoomLevel() - 0.5) },
        { label: 'Tamanho normal', accelerator: 'CmdOrCtrl+0', click: () => wc() && wc().setZoomLevel(0) },
        { type: 'separator' },
        { label: 'Tela cheia', accelerator: 'F11', click: () => panel && panel.setFullScreen(!panel.isFullScreen()) },
      ],
    },
    {
      label: 'Suporte',
      submenu: [
        { label: 'Falar com o suporte (WhatsApp)', click: () => shell.openExternal(DEV.links.whatsapp) },
        { label: 'Sobre e contato do desenvolvedor…', click: openAbout },
        { type: 'separator' },
        { label: 'Procurar atualizações', click: () => checkUpdates(true) },
        { label: 'Novidades das versões (changelog)', click: () => shell.openExternal(`https://github.com/${REPO}/releases`) },
        { type: 'separator' },
        { label: `Versão ${app.getVersion()}`, enabled: false },
      ],
    },
  ]);
}

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
    openSplash();
    openPanel();
  }
  startLoop();
  startAlerts();
  if (!app.isPackaged && process.env.FC_OPEN_ABOUT) openAbout(); // teste da tela de suporte (desenvolvimento)
  if (!app.isPackaged && process.env.FC_TEST_SECURE) setTimeout(() => openSecure('admin/orders.php'), 4000); // teste (desenvolvimento)
  if (!app.isPackaged && process.env.FC_TEST_SETTINGS) setTimeout(openSettings, Number(process.env.FC_TEST_SETTINGS)); // teste (desenvolvimento)
  checkUpdates();
  setInterval(checkUpdates, 6 * 60 * 60 * 1000); // procura atualização a cada 6 horas
});
