/*! Archie AI: botón y ventana del asistente para incrustar en otras herramientas.
 * Uso (en la página de la herramienta anfitriona):
 *   <script src="https://TU-DOMINIO-DE-ARCHIE-AI/widget.js" async></script>
 *   ArchieAI.montar({ obtenerUrl: function () { return fetch('/mi-servidor/archie-ai-sesion').then(function (r) { return r.json(); }).then(function (j) { return j.url; }); } });
 * La dirección (url) la entrega Archie AI a TU SERVIDOR (nunca a tu navegador con una clave): ver el centro de ayuda. */
(function () {
  'use strict';
  var actual = document.currentScript;
  var ORIGEN = actual && actual.src ? new URL(actual.src).origin : null;
  var montado = false;

  function crear(tag, atributos, estilo) {
    var e = document.createElement(tag);
    Object.keys(atributos || {}).forEach(function (k) { e.setAttribute(k, atributos[k]); });
    Object.keys(estilo || {}).forEach(function (k) { e.style[k] = estilo[k]; });
    return e;
  }

  window.ArchieAI = {
    montar: function (opciones) {
      if (montado || !ORIGEN || !opciones || typeof opciones.obtenerUrl !== 'function') return;
      montado = true;
      var abierto = false, cargando = false;
      var boton = crear('button', { type: 'button', 'aria-label': 'Abrir el asistente Archie AI', 'aria-expanded': 'false' }, {
        position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483000', minHeight: '48px', padding: '0 20px', border: '0', borderRadius: '999px',
        background: '#6265FE', color: '#fff', font: '600 16px Dosis, Trebuchet MS, Arial, sans-serif', cursor: 'pointer', boxShadow: '0 4px 16px rgba(19,17,38,.3)'
      });
      boton.textContent = opciones.texto || 'Archie AI';
      var marco = crear('iframe', { title: 'Asistente Archie AI', referrerpolicy: 'no-referrer', allow: '', sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox' }, {
        position: 'fixed', right: '16px', bottom: '76px', zIndex: '2147483000', width: 'min(400px, calc(100vw - 32px))', height: 'min(640px, calc(100vh - 100px))',
        border: '1px solid #E4E6FB', borderRadius: '16px', background: '#fff', boxShadow: '0 8px 32px rgba(19,17,38,.3)', display: 'none'
      });
      function cerrar() { abierto = false; marco.style.display = 'none'; boton.setAttribute('aria-expanded', 'false'); boton.focus(); }
      function abrir() {
        if (abierto || cargando) return;
        if (marco.getAttribute('src')) { abierto = true; marco.style.display = 'block'; boton.setAttribute('aria-expanded', 'true'); return; }
        cargando = true;
        Promise.resolve().then(function () { return opciones.obtenerUrl(); }).then(function (url) {
          var u = new URL(String(url));
          // Solo se carga el widget de Archie AI desde el mismo sitio de este script: nunca una dirección ajena.
          if (u.origin !== ORIGEN || !/^\/widget\/[0-9a-f-]{36}$/i.test(u.pathname)) throw new Error('url_no_valida');
          marco.setAttribute('src', u.toString());
          abierto = true; marco.style.display = 'block'; boton.setAttribute('aria-expanded', 'true');
        }).catch(function () { /* la herramienta anfitriona decide cómo avisar */ }).then(function () { cargando = false; });
      }
      boton.addEventListener('click', function () { if (abierto) cerrar(); else abrir(); });
      document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && abierto) cerrar(); });
      window.addEventListener('message', function (ev) {
        if (ev.origin !== ORIGEN || ev.source !== marco.contentWindow || !ev.data) return;
        // La sesión del widget dura 2 horas: al vencer, la próxima vez que se abra se pide un enlace nuevo a la herramienta anfitriona.
        if (ev.data.tipo === 'archie:expirado') { marco.removeAttribute('src'); cerrar(); }
        if (ev.data.tipo === 'archie:cerrar') cerrar();
      });
      document.body.appendChild(marco);
      document.body.appendChild(boton);
    }
  };
})();
