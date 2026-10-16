/**
 * Modo offline do painel (Feliz Cristais Gestão).
 * - Com internet: o painel funciona normalmente e, em segundo plano, o app guarda no computador uma cópia de cada
 *   página do painel e de cada arquivo (CSS, JS, imagens) que foi aberto.
 * - Sem internet: o app passa a responder com as cópias guardadas e avisa o usuário. O que for salvo (formulários e
 *   envios do painel) entra numa fila local ("carga").
 * - Quando a conexão volta: a carga é enviada ao servidor, em ordem, e gravada no banco; o painel volta ao normal.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SKIP = /(notify\.php|\/notify(\?|$)|print_api|push_api|push_sub|ao_vivo=|[?&](csv|pacote|baixar|config)=|\/cron\.php|\/track\.php|consent\.php|\/logout|\/sw\.js)/;
const NO_QUEUE = /(notify|print_api|push_api|push_sub|track\.php|consent\.php|\/login(\.php)?(\?|$)|\/logout)/;

function create(ctx) {
  const ses = ctx.session;
  const dir = path.join(ctx.userData, 'offline');
  const files = path.join(dir, 'arquivos');
  fs.mkdirSync(files, { recursive: true });
  const idxFile = path.join(dir, 'indice.json');
  const queueFile = path.join(dir, 'carga.json');
  let index = {};
  let queue = [];
  try { index = JSON.parse(fs.readFileSync(idxFile, 'utf8')); } catch (e) {}
  try { queue = JSON.parse(fs.readFileSync(queueFile, 'utf8')); } catch (e) {}
  let online = true;
  let handling = false;
  let probe = null;
  let syncing = false;
  let saveTimer = null;
  const inflight = new Set();

  // Teste em desenvolvimento: com o arquivo FC_SIM_OFFLINE presente, age como se estivesse sem internet
  const simOff = () => !!(process.env.FC_SIM_OFFLINE && fs.existsSync(process.env.FC_SIM_OFFLINE));
  const net = (input, init = {}) => {
    if (simOff()) return Promise.reject(new TypeError('sem internet (simulado)'));
    return ses.fetch(input, { ...init, bypassCustomProtocolHandlers: true });
  };
  const saveIndex = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => fs.writeFile(idxFile, JSON.stringify(index), () => {}), 1500); };
  const saveQueue = () => fs.writeFileSync(queueFile, JSON.stringify(queue));
  const key = (u) => crypto.createHash('sha1').update(u).digest('hex');
  const site = () => { try { return new URL(ctx.siteBase()).origin; } catch (e) { return ''; } };
  const sameSite = (u) => { try { return new URL(u).origin === site(); } catch (e) { return false; } };

  // ---------------------------------------------------------------- Cópia local (com internet)
  async function store(url) {
    if (SKIP.test(url) || inflight.has(url) || simOff()) return;
    inflight.add(url);
    try {
      const res = await net(url, { signal: AbortSignal.timeout(20000) });
      const finalUrl = res.url || url;
      if (res.status !== 200 || (/\/login/.test(new URL(finalUrl).pathname) && !/\/login/.test(new URL(url).pathname))) return;
      if (/attachment/i.test(res.headers.get('content-disposition') || '')) return;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 8 * 1048576) return;
      const k = key(url);
      fs.writeFileSync(path.join(files, k), buf);
      index[url] = { k, type: res.headers.get('content-type') || '', at: Date.now() };
      saveIndex();
    } catch (e) {
      // segue sem a cópia
    } finally {
      inflight.delete(url);
    }
  }
  // Tudo o que o painel carrega com sucesso ganha uma cópia (arquivos só uma vez; páginas a cada visita)
  ses.webRequest.onCompleted({ urls: ['http://*/*', 'https://*/*'] }, (d) => {
    if (handling || d.method !== 'GET' || d.statusCode !== 200 || !sameSite(d.url)) return;
    const page = d.resourceType === 'mainFrame' || d.resourceType === 'subFrame';
    const asset = ['stylesheet', 'script', 'image', 'font'].includes(d.resourceType);
    if (page && /\/admin\//.test(new URL(d.url).pathname)) store(d.url);
    else if (asset && !index[d.url]) store(d.url);
  });

  function cached(url) {
    const e = index[url] || index[url.replace(/#.*$/, '')];
    if (!e) return null;
    try { return { body: fs.readFileSync(path.join(files, e.k)), type: e.type, at: e.at }; } catch (err) { return null; }
  }
  const isNav = (req) => req.headers.get('sec-fetch-mode') === 'navigate' || /text\/html/.test(req.headers.get('accept') || '');

  // ---------------------------------------------------------------- Sem internet: responde com as cópias
  async function handler(req) {
    const url = req.url;
    if (!sameSite(url)) {
      try { return await net(req); } catch (e) { return new Response('', { status: 503 }); }
    }
    if (/\/sw\.js(\?|$)/.test(url)) return new Response('', { status: 404 });
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD') {
      try {
        const res = await net(req, { signal: AbortSignal.timeout(5000) });
        setOnline(true);
        return res;
      } catch (e) {
        const c = cached(url);
        if (c) return new Response(method === 'HEAD' ? null : c.body, { status: 200, headers: { 'content-type': c.type, 'x-fc-offline': String(c.at) } });
        if (isNav(req)) return new Response(ctx.offlinePage(), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
        return new Response(JSON.stringify({ ok: false, offline: true, error: 'Sem internet no momento.' }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
    }
    // Formulários e envios: guarda na carga
    const body = Buffer.from(await req.arrayBuffer());
    const headers = {};
    req.headers.forEach((v, k) => { if (/^(content-type|accept|x-csrf|x-requested-with|x-print-key)$/i.test(k)) headers[k] = v; });
    if (NO_QUEUE.test(url)) {
      return new Response(JSON.stringify({ ok: false, offline: true, error: 'Sem internet no momento.' }), { status: 503, headers: { 'content-type': 'application/json' } });
    }
    const referer = req.headers.get('referer') || url;
    queue.push({ id: crypto.randomUUID(), url, method, headers, body: body.toString('base64'), at: Date.now(), page: referer });
    saveQueue();
    ctx.onQueued(queue.length, isNav(req));
    if (isNav(req)) return new Response(null, { status: 303, headers: { location: referer } });
    return new Response(JSON.stringify({ ok: true, queued: true, offline: true, message: 'Sem internet: guardado no app e será enviado quando a conexão voltar.' }), { status: 202, headers: { 'content-type': 'application/json' } });
  }
  function intercept(on) {
    if (on === handling) return;
    handling = on;
    for (const scheme of ['http', 'https']) {
      try {
        if (on) ses.protocol.handle(scheme, handler); else ses.protocol.unhandle(scheme);
      } catch (e) {}
    }
  }

  // ---------------------------------------------------------------- Estado da conexão
  function setOnline(v) {
    if (online === v) return;
    online = v;
    clearInterval(probe);
    if (!v) {
      intercept(true);
      probe = setInterval(check, 8000);
      ctx.onState(false, queue.length);
    } else {
      intercept(false);
      ctx.onState(true, queue.length);
      sync();
    }
  }
  async function check() {
    try {
      const r = await net(ctx.siteBase() + '/manifest.php?app=admin', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
      setOnline(r.status < 500);
    } catch (e) {
      setOnline(false);
    }
  }
  /** O painel não carregou por falta de conexão: liga o modo offline. */
  function failed(code) {
    // -106 sem internet, -105 nome não resolvido, -102 recusado, -118 tempo esgotado, -109 inacessível, -21 rede mudou
    if ([-106, -105, -102, -118, -109, -21, -7, -101, -100, -130, -137].includes(code)) setOnline(false);
  }

  /** Envia a carga pendente ao servidor, na ordem em que foi feita. */
  async function sync() {
    if (syncing || !queue.length || !online) return;
    syncing = true;
    let sent = 0;
    let bad = 0;
    while (queue.length) {
      const it = queue[0];
      try {
        const res = await net(it.url, { method: it.method, headers: it.headers, body: Buffer.from(it.body, 'base64'), signal: AbortSignal.timeout(30000) });
        if (res.status >= 400) bad++; else sent++;
        queue.shift();
        saveQueue();
      } catch (e) {
        setOnline(false); // caiu de novo: continua depois
        break;
      }
    }
    syncing = false;
    ctx.onSynced(sent, bad, queue.length);
  }

  /** Guarda as páginas principais do painel para usar sem internet. */
  async function precache(paths) {
    for (const p of paths) {
      if (!online) return;
      await store(ctx.siteBase() + '/' + p);
    }
  }

  if (process.env.FC_SIM_OFFLINE) setInterval(() => { if (simOff() && online) setOnline(false); }, 2000);

  return {
    isOnline: () => online,
    pending: () => queue.length,
    sync,
    check,
    failed,
    precache,
    // Chamado quando uma requisição do app (avisos, impressão) falha por conexão
    lost: () => setOnline(false),
  };
}

module.exports = { create };
