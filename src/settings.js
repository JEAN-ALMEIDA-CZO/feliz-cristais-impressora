// Dentro do painel: abre como lightbox
(function () {
  if (!/[?&]lightbox=1/.test(location.search)) return;
  var html = document.documentElement;
  html.classList.add('lightbox');
  var card = document.createElement('div');
  card.className = 'lb-card';
  while (document.body.firstChild) card.appendChild(document.body.firstChild);
  var x = document.createElement('button');
  x.type = 'button'; x.className = 'lb-x'; x.setAttribute('aria-label', 'Fechar'); x.textContent = '×';
  card.insertBefore(x, card.firstChild);
  document.body.appendChild(card);
  var close = function () { html.classList.add('lb-out'); setTimeout(function () { window.fc.close(); }, 220); };
  x.addEventListener('click', close);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  document.body.addEventListener('mousedown', function (e) { if (e.target === document.body) close(); });
  var openPanel = document.getElementById('panel');
  if (openPanel) openPanel.hidden = true; // já está no painel
})();
(function () {
  var f = document.getElementById('f');
  var $ = function (id) { return document.getElementById(id); };

  function showState(s) {
    $('status').classList.toggle('on', !!s.online);
    $('st-title').textContent = s.online ? 'Impressora conectada à loja' : 'Impressora desconectada';
    $('st-msg').textContent = s.message + (s.last ? ' · último: ' + s.last : '');
  }
  function showLog(list) {
    var box = $('log');
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<div>Nada por aqui ainda.</div>'; return; }
    list.forEach(function (l) {
      var d = document.createElement('div');
      d.className = l.kind;
      d.textContent = l.at + '  ' + l.text;
      box.appendChild(d);
    });
  }
  function fillPrinters(list, current) {
    var sel = $('printer');
    sel.innerHTML = '<option value="">Impressora padrão do sistema</option>';
    list.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.name;
      o.textContent = p.label + (p.isDefault ? ' (padrão)' : '');
      sel.appendChild(o);
    });
    sel.value = current || '';
  }

  window.fc.get().then(function (d) {
    f.site.value = d.config.site || '';
    f.key.value = d.config.key || '';
    f.copies.value = String(d.config.copies || 1);
    f.every.value = String(d.config.every || 5);
    f.autostart.checked = !!d.config.autostart;
    f.notify.checked = !!d.config.notify;
    f.alerts.checked = d.config.alerts !== false;
    f.sound.checked = d.config.sound !== false;
    f.printOn.checked = d.config.printOn !== false;
    fillPrinters(d.printers, d.config.printer);
    showState(d.state);
    showLog(d.log);
    $('ver').textContent = 'Versão ' + d.version;
  });
  function fillConfig(c) {
    f.site.value = c.site || '';
    f.key.value = c.key || '';
    f.copies.value = String(c.copies || 1);
  }
  window.fc.on('config', fillConfig);
  window.fc.on('state', showState);
  $('import').addEventListener('click', function () { window.fc.importFile(); });
  var drop = $('drop');
  ['dragenter', 'dragover'].forEach(function (t) { document.addEventListener(t, function (ev) { ev.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (t) { document.addEventListener(t, function (ev) { ev.preventDefault(); if (t === 'drop' || ev.target === document.documentElement) drop.classList.remove('over'); }); });
  document.addEventListener('drop', function (ev) {
    var file = ev.dataTransfer && ev.dataTransfer.files[0];
    if (file) window.fc.importFile(window.fc.pathFor(file));
  });
  window.fc.on('log', showLog);

  f.addEventListener('submit', function (ev) {
    ev.preventDefault();
    $('save').disabled = true;
    $('save').textContent = 'Conectando…';
    window.fc.save({
      site: f.site.value.trim(), key: f.key.value.trim(), printer: f.printer.value,
      copies: f.copies.value, every: f.every.value, autostart: f.autostart.checked, notify: f.notify.checked,
      alerts: f.alerts.checked, sound: f.sound.checked, printOn: f.printOn.checked,
    }).then(function (r) {
      showState(r.state);
      $('save').disabled = false;
      $('save').textContent = 'Salvar e conectar';
    });
  });
  $('test').addEventListener('click', function () {
    $('test').disabled = true;
    window.fc.test().then(function () { $('test').disabled = false; });
  });
  $('refresh').addEventListener('click', function () {
    window.fc.printers().then(function (list) { fillPrinters(list, f.printer.value); });
  });
  $('upd').addEventListener('click', function () { window.fc.update(); });
  $('panel').addEventListener('click', function () { window.fc.panel(); });
  $('about').addEventListener('click', function () { window.fc.about(); });
})();
