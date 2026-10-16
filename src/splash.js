(function () {
  var msgs = ['Iniciando…', 'Conectando à loja…', 'Carregando o painel…', 'Quase pronto ✨'];
  var i = 0, el = document.getElementById('msg');
  setInterval(function () { if (i < msgs.length - 1) el.textContent = msgs[++i]; }, 900);
  var v = new URLSearchParams(location.search).get('v');
  if (v) document.getElementById('ver').textContent = 'Versão ' + v;
})();
