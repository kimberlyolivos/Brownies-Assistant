// Reemplaza window.claude por Supabase (datos + login) y /api/chat (Gemini).
(function () {
  'use strict';
  var cfg = window.APP_CONFIG || {};
  window.BROWNIE_WEB = true;
  var sb = null, sessionP = null;

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === 'text') n.textContent = attrs[k]; else n.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }
  var css = el('style', {text:
    '.lg{position:fixed;inset:0;z-index:99;background:var(--bg,#F2F5F1);display:flex;align-items:center;justify-content:center;padding:24px}' +
    '.lg form,.lg div.box{width:100%;max-width:360px;background:var(--surface,#fff);border:1px solid var(--line,#ddd);border-radius:18px;padding:24px;display:flex;flex-direction:column;gap:12px;color:var(--ink,#111);font:15px system-ui,sans-serif}' +
    '.lg h1{margin:0;font-size:22px}.lg p{margin:0;color:var(--ink-2,#555);font-size:14px;line-height:1.4}' +
    '.lg input{font:inherit;padding:12px;border:1px solid var(--line,#ccc);border-radius:12px;background:#fff;color:#111}' +
    '.lg button{font:inherit;font-weight:600;padding:12px;border:0;border-radius:12px;background:var(--accent,#6B3F22);color:#fff;cursor:pointer}' +
    '.lg button.ghost{background:none;color:var(--ink-2,#555);font-weight:500}'});
  document.head.appendChild(css);

  function overlay(content) {
    var old = document.getElementById('lg'); if (old) old.remove();
    if (!content) return;
    var o = el('div', {id:'lg', class:'lg'}, [content]); document.body.appendChild(o);
  }
  function loginForm(msg) {
    var inp = el('input', {type:'email', placeholder:'tu-correo@ejemplo.com', required:'', autocomplete:'email'});
    var info = el('p', {text: msg || 'Entra con tu correo. Te enviamos un enlace y un código para ingresar, sin contraseña.'});
    var btn = el('button', {type:'submit', text:'Enviarme el enlace'});
    var f = el('form', {}, [el('h1', {text:"Brownie's Assistant"}), info, inp, btn]);
    var code = el('input', {type:'text', inputmode:'numeric', autocomplete:'one-time-code', placeholder:'Código del correo', maxlength:'8'});
    var enter = el('button', {type:'button', text:'Entrar con el código'});
    code.style.display = enter.style.display = 'none';
    f.appendChild(code); f.appendChild(enter);
    enter.onclick = function () {
      var t = code.value.trim(); if (!t) return;
      enter.disabled = true;
      sb.auth.verifyOtp({email: inp.value.trim(), token: t, type:'email'}).then(function (r) {
        enter.disabled = false;
        if (r.error) info.textContent = 'Ese código no sirve o ya venció. Pide uno nuevo.';
      });
    };
    f.onsubmit = function (ev) {
      ev.preventDefault();
      sb.auth.signInWithOtp({email: inp.value.trim(), options:{emailRedirectTo: location.origin + location.pathname}}).then(function (r) {
        info.textContent = r.error ? 'No se pudo enviar el enlace. Revisa el correo e intenta otra vez.' : 'Listo. Revisa tu correo: abre el enlace o escribe aquí el código que te llegó.';
        if (!r.error) { code.style.display = enter.style.display = ''; code.focus(); }
      });
    };
    return f;
  }
  function denied() {
    var b = el('button', {class:'ghost', type:'button', text:'Salir'});
    b.onclick = function () { sb.auth.signOut().then(function () { location.reload(); }); };
    return el('div', {class:'box'}, [el('h1', {text:'Sin acceso'}), el('p', {text:'Este correo todavía no está en la lista del diario. Pide que lo agreguen e intenta de nuevo.'}), b]);
  }

  function ready() {
    if (sessionP) return sessionP;
    sessionP = new Promise(function (resolve) {
      if (!window.supabase || !cfg.SUPABASE_URL || /TU-PROYECTO/.test(cfg.SUPABASE_URL)) {
        overlay(el('div', {class:'box'}, [el('h1', {text:'Falta configurar'}), el('p', {text:'Edita public/config.js con la URL y la anon key de Supabase.'})])); return;
      }
      sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
      function check(session) {
        if (!session) { overlay(loginForm()); return; }
        sb.rpc('is_member').then(function (r) {
          if (r.data === true) { overlay(null); resolve(session); } else overlay(denied());
        });
      }
      sb.auth.getSession().then(function (r) { check(r.data && r.data.session); });
      var fired = false;
      sb.auth.onAuthStateChange(function (ev, session) {
        if (ev === 'SIGNED_IN' && session && !fired) { fired = true; check(session); }
        if (ev === 'SIGNED_OUT') overlay(loginForm());
      });
    });
    return sessionP;
  }

  function fromRow(r) { var o = Object.assign({}, r); o.createdAt = o.created_at; delete o.created_at; Object.keys(o).forEach(function (k) { if (o[k] === null) delete o[k]; }); return o; }
  function toRow(d) { var o = Object.assign({}, d); if ('createdAt' in o) { o.created_at = o.createdAt; delete o.createdAt; } return o; }

  var listeners = [];
  function reloadAll() { listeners.forEach(function (l) { l(); }); }

  function collection() {
    var field = 'at', asc = true, lim = 600;
    var q = {
      orderBy: function (f, dir) { field = f; asc = dir !== 'desc'; return q; },
      limit: function (n) { lim = n; return q; },
      onSnapshot: function (ok, bad) {
        var timer = null;
        function load() {
          sb.from('entries').select('*').order(field, {ascending: asc}).limit(lim).then(function (r) {
            if (r.error) { if (bad) bad(r.error); return; }
            ok({docs: r.data.map(function (row) { var id = row.id, data = fromRow(row); delete data.id; return {id: id, data: function () { return data; }}; })});
          });
        }
        listeners.push(load); load();
        sb.channel('entries-live').on('postgres_changes', {event:'*', schema:'public', table:'entries'}, function () { clearTimeout(timer); timer = setTimeout(load, 250); }).subscribe();
        return function () {};
      },
      add: function (d) {
        return sb.from('entries').insert(toRow(d)).select('id').then(function (r) {
          if (r.error) throw r.error; reloadAll(); return {id: r.data && r.data[0] && r.data[0].id};
        });
      },
      doc: function (id) {
        return {
          delete: function () { return sb.from('entries').delete().eq('id', id).then(function (r) { if (r.error) throw r.error; reloadAll(); }); },
          update: function (d) { return sb.from('entries').update(toRow(d)).eq('id', id).select('id').then(function (r) { if (r.error) throw r.error; if (!r.data || !r.data.length) throw new Error('sin cambios'); reloadAll(); }); }
        };
      }
    };
    return q;
  }

  function chatSample(input, opts) {
    opts = opts || {};
    return ready().then(function (session) {
      return sb.auth.getSession().then(function (r) { return (r.data && r.data.session) || session; });
    }).then(function (session) {
      var turns = (input || []).map(function (m) { return {role: m.role, content: m.content}; });
      return fetch('/api/chat', {method:'POST', signal: opts.signal, headers:{'Content-Type':'application/json', Authorization:'Bearer ' + session.access_token}, body: JSON.stringify({turns: turns})});
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (b) {
        if (!res.ok) { var e = new Error('chat ' + res.status); e.code = res.status === 429 ? 'rate_limited' : res.status === 401 ? 'session_expired' : 'error'; throw e; }
        if (b.saved && b.saved.length && window.__chatSaved) window.__chatSaved(b.saved);
        if (opts.onText) opts.onText({text: b.text});
        return {text: b.text};
      });
    }).catch(function (e) { if (e && e.name === 'AbortError') { var c = new Error('cancelled'); c.code = 'cancelled'; throw c; } throw e; });
  }
  chatSample.limits = function () { return Promise.resolve({tools: {}}); };

  window.claude = {
    use: function (name) {
      if (name === 'db') return ready().then(function () { return {collection: collection}; });
      if (name === 'user') return Promise.resolve({can: function () { return Promise.resolve(true); }});
      if (name === 'downloads') return Promise.resolve({save: function (o) {
        var data = o.data, type = /\.csv$/i.test(o.filename) ? 'text/csv' : /\.json$/i.test(o.filename) ? 'application/json' : 'text/plain';
        var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], {type: type + ';charset=utf-8'})); a.download = o.filename;
        document.body.appendChild(a); a.click(); a.remove(); return Promise.resolve({status: 'saved'});
      }});
      if (name === 'sample') return Promise.resolve(chatSample);
      return Promise.resolve(null);
    }
  };
})();
