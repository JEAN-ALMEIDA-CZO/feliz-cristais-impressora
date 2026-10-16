(function () {
  window.about.get().then(function (d) {
    document.getElementById('ver').textContent = 'Versão ' + d.version;
    document.getElementById('dev').textContent = d.dev;
    document.getElementById('store').textContent = d.store ? d.store.replace(/^https?:\/\//, '') : 'Loja não configurada';
  });
  document.querySelectorAll('[data-open]').forEach(function (b) {
    b.addEventListener('click', function () { window.about.open(b.getAttribute('data-open')); });
  });
  document.getElementById('upd').addEventListener('click', function () { window.about.update(); });
})();
