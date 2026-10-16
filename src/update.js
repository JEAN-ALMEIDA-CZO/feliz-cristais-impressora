(function () {
  var $ = function (id) { return document.getElementById(id); };
  var mb = function (b) { return b ? (b / 1048576).toFixed(1).replace('.', ',') + ' MB' : '—'; };
  var date = function (d) { try { return d ? new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }) : ''; } catch (e) { return ''; } };
  var lastNotes = '';
  var countdown = null;

  function show(id, on) { $(id).hidden = !on; }
  function msg(text, kind) {
    var m = $('msg');
    m.className = 'msg' + (text ? ' on ' + (kind || '') : '');
    m.textContent = text || '';
  }
  function notes(list) {
    var key = JSON.stringify(list || []);
    if (key === lastNotes) return;
    lastNotes = key;
    var box = $('notes');
    if (!list || !list.length) { box.innerHTML = '<div class="rel"><p class="empty">Melhorias e correções para deixar o app mais rápido e estável.</p></div>'; return; }
    box.innerHTML = list.map(function (n) {
      return '<div class="rel"><div class="rel-head"><b>Versão ' + n.version + '</b><small>' + date(n.date) + '</small></div>' +
        (n.html || '<p class="empty">Melhorias e correções.</p>') + '</div>';
    }).join('');
  }

  function render(u) {
    $('v-cur').textContent = u.current;
    $('v-new').textContent = u.version || u.current;
    $('vers').hidden = !u.version || u.state === 'latest' || u.state === 'dev' || u.state === 'checking';
    ['later', 'close', 'install', 'restart', 'retry'].forEach(function (b) { show(b, false); });
    $('prog').classList.remove('on');
    msg('');
    $('foot').textContent = '';
    if (countdown && u.state !== 'ready') { clearInterval(countdown); countdown = null; }

    if (u.state === 'checking') {
      $('title').innerHTML = '<span class="spin"></span>Procurando atualizações…';
      $('sub').textContent = 'Conferindo as versões publicadas no GitHub.';
      $('badge').textContent = '⟳';
      $('notes-title').hidden = true; $('notes').hidden = true;
      show('close', true);
      return;
    }
    if (u.state === 'latest' || u.state === 'dev') {
      $('title').textContent = 'Você está na versão mais nova ✨';
      $('sub').textContent = u.state === 'dev' ? 'Atualização automática só funciona na versão instalada.' : 'Feliz Cristais Gestão ' + u.current + ' é a versão mais recente.';
      $('badge').textContent = '✓';
      $('notes-title').hidden = true; $('notes').hidden = true;
      show('close', true);
      return;
    }
    $('notes-title').hidden = false; $('notes').hidden = false;
    notes(u.notes);
    if (u.state === 'available') {
      $('title').textContent = 'Nova versão disponível';
      $('sub').textContent = 'A versão ' + u.version + ' do Feliz Cristais Gestão está pronta para você.';
      $('badge').textContent = '⬆';
      show('later', true); show('install', true);
      $('foot').textContent = 'A impressão e os avisos continuam funcionando durante o download.';
    } else if (u.state === 'downloading') {
      var p = u.progress || {};
      $('title').innerHTML = '<span class="spin"></span>Baixando a versão ' + u.version;
      $('sub').textContent = 'Pode continuar usando o app normalmente.';
      $('badge').textContent = '⬇';
      $('prog').classList.add('on');
      $('bar').style.width = Math.max(2, Math.min(100, p.percent || 0)) + '%';
      $('p-pct').innerHTML = '<b>' + Math.floor(p.percent || 0) + '%</b>';
      $('p-size').textContent = p.total ? mb(p.transferred) + ' de ' + mb(p.total) : '';
      $('p-speed').textContent = p.speed ? mb(p.speed) + '/s' : '';
      show('close', true);
      $('close').textContent = 'Baixar em segundo plano';
    } else if (u.state === 'ready') {
      $('title').textContent = 'Atualização pronta para instalar 🎉';
      $('sub').textContent = 'O app vai fechar por alguns segundos, instalar a versão ' + u.version + ' e abrir de novo.';
      $('badge').textContent = '✓';
      $('prog').classList.add('on');
      $('bar').style.width = '100%';
      $('p-pct').innerHTML = '<b>100%</b>'; $('p-speed').textContent = '';
      show('restart', true); show('later', true);
      $('later').textContent = 'Instalar quando eu fechar o app';
      msg('Download concluído. Salve o que estiver fazendo no painel antes de reiniciar.', 'ok');
    } else if (u.state === 'error') {
      $('title').textContent = 'Não foi possível atualizar';
      $('sub').textContent = 'Tudo continua funcionando na versão ' + u.current + '.';
      $('badge').textContent = '!';
      msg(u.error || 'Erro ao baixar a atualização.', 'err');
      show('later', true); show('retry', true);
    }
  }

  $('install').addEventListener('click', function () { $('install').disabled = true; window.upd.download().then(function () { $('install').disabled = false; }); });
  $('retry').addEventListener('click', function () { window.upd.download(); });
  $('later').addEventListener('click', function () { window.upd.later(); });
  $('close').addEventListener('click', function () { window.upd.close(); });
  $('restart').addEventListener('click', function () {
    $('restart').disabled = true; $('later').disabled = true;
    $('restart').innerHTML = '<span class="spin"></span>Reiniciando…';
    window.upd.restart();
  });
  window.upd.on(render);
  window.upd.get().then(render);
})();
