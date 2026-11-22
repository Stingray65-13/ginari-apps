(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var state = { data: null, selected: new Set(), cat: 'all', q: '', ops: {} };
  var COLORS = { gov: '#2C5AA0', banks: '#1E5963', social: '#2F4A6D', media: '#B56A52', telecom: '#4F6B5B', life: '#7A6450', ai: '#0B0F10' };
  var rub = function (n) { return n.toLocaleString('ru-RU') + ' ₽'; };
  var plural = function (n, a, b, c) { var m = n % 10, h = n % 100; return (m === 1 && h !== 11) ? a : (m >= 2 && m <= 4 && (h < 10 || h >= 20)) ? b : c; };
  var appsWord = function (n) { return n + ' ' + plural(n, 'приложение', 'приложения', 'приложений'); };

  function store() { try { localStorage.setItem('ginari_sel', JSON.stringify([...state.selected])); } catch (e) {} }
  function restore() { try { (JSON.parse(localStorage.getItem('ginari_sel') || '[]')).forEach(function (s) { state.selected.add(s); }); } catch (e) {} }

  function unitPrice(n) {
    var t = state.data.tiers;
    for (var i = 0; i < t.length; i++) if (n >= t[i].from && n <= t[i].to) return t[i].price;
    return t[t.length - 1].price;
  }
  function basePrice() { return state.data.tiers[0].price; }
  function appBySlug(s) { return state.data.apps.find(function (a) { return a.slug === s; }); }
  function availableSlugs(list) { return list.filter(function (s) { var a = appBySlug(s); return a && a.available; }); }

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    for (var k in attrs || {}) {
      if (attrs[k] == null) continue;
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }

  // ---------- наборы ----------
  function setApps(set) {
    var apps = set.apps.slice();
    if (set.operator && state.ops[set.id]) apps[0] = state.ops[set.id];
    return availableSlugs(apps);
  }
  function renderSets() {
    var g = $('#setsGrid'); g.innerHTML = '';
    state.data.sets.forEach(function (set) {
      var apps = setApps(set); var n = apps.length; if (!n) return;
      var price = unitPrice(n) * n, old = basePrice() * n;
      var names = apps.map(function (s) { return appBySlug(s).name; }).join(' · ');
      var ops = null;
      if (set.operator) {
        var cur = state.ops[set.id] || set.apps[0];
        ops = el('div', { class: 'op-select', 'aria-label': 'Ваш оператор' }, availableSlugs(set.operator).map(function (s) {
          return el('button', { type: 'button', 'aria-pressed': String(s === cur), text: appBySlug(s).name, onclick: function () { state.ops[set.id] = s; renderSets(); } });
        }));
      }
      g.appendChild(el('article', { class: 'set' + (set.featured ? ' featured' : '') }, [
        el('div', { class: 'set-top' }, [el('h3', { text: set.name }), set.featured ? el('span', { class: 'set-tag', text: 'выгоднее всего' }) : null]),
        el('p', { class: 'muted', style: 'margin:0', text: set.note }),
        ops,
        el('p', { class: 'set-apps', style: 'margin:0', text: names }),
        el('div', { class: 'set-price' }, [
          el('b', { text: rub(price) }),
          old > price ? el('span', { class: 'old', text: rub(old) }) : null,
          old > price ? el('span', { class: 'save', text: 'выгода ' + rub(old - price) }) : null,
          el('span', { class: 'muted small', text: n + ' × ' + rub(unitPrice(n)) }),
        ]),
        el('div', { class: 'set-actions' }, [
          el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: 'Выбрать набор', onclick: function () { apps.forEach(function (s) { state.selected.add(s); }); changed(); openCheckout(); } }),
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Изменить состав', onclick: function () { apps.forEach(function (s) { state.selected.add(s); }); changed(); $('#catalog').scrollIntoView(); } }),
        ]),
      ]));
    });
  }

  // ---------- сетка цен ----------
  function renderTiers() {
    var n = state.selected.size, t = $('#tiers'); t.innerHTML = '';
    state.data.tiers.forEach(function (x) {
      var label = x.to >= state.data.maxApps ? 'от ' + x.from + ' приложений' : x.from + '–' + x.to + ' ' + plural(x.to, 'приложение', 'приложения', 'приложений');
      t.appendChild(el('div', { class: 'tier' + (n >= x.from && n <= x.to ? ' active' : '') }, [el('b', { text: rub(x.price) }), el('span', { text: label })]));
    });
  }

  // ---------- каталог ----------
  function renderCats() {
    var c = $('#cats'); c.innerHTML = '';
    var cats = [{ id: 'all', name: 'Все' }].concat(state.data.categories.filter(function (k) { return state.data.apps.some(function (a) { return a.cat === k.id; }); }));
    cats.forEach(function (k) {
      c.appendChild(el('button', { type: 'button', role: 'tab', 'aria-selected': String(state.cat === k.id), text: k.name, onclick: function () { state.cat = k.id; renderCats(); renderApps(); } }));
    });
  }
  function renderApps() {
    var g = $('#appsGrid'); g.innerHTML = '';
    var q = state.q.trim().toLowerCase();
    var list = state.data.apps.filter(function (a) {
      return (state.cat === 'all' || a.cat === state.cat) && (!q || a.name.toLowerCase().indexOf(q) >= 0 || (a.desc || '').toLowerCase().indexOf(q) >= 0);
    });
    list.sort(function (a, b) { return (b.available - a.available); });
    if (!list.length) { g.appendChild(el('p', { class: 'muted', text: 'Ничего не нашли. Напишите в поддержку — подскажем.' })); return; }
    list.forEach(function (a) {
      var on = state.selected.has(a.slug);
      g.appendChild(el('button', {
        type: 'button', class: 'app', 'aria-pressed': String(on), disabled: a.available ? null : 'disabled',
        onclick: function () { if (!a.available) return; if (on) state.selected.delete(a.slug); else if (state.selected.size < state.data.maxApps) state.selected.add(a.slug); changed(); },
      }, [
        a.icon && /^https:\/\/exapplication\.ru\//.test(a.icon)
          ? el('img', { class: 'app-ico app-img', src: a.icon, alt: '', loading: 'lazy', width: '42', height: '42' })
          : el('span', { class: 'app-ico', style: 'background:' + (COLORS[a.cat] || '#1E5963'), text: a.name.replace(/^[^A-Za-zА-Яа-яЁё0-9]+/, '').charAt(0).toUpperCase() }),
        el('span', { class: 'app-txt' }, [el('b', { text: a.name }), el('span', { text: a.available ? (a.desc || '') : 'временно недоступно' })]),
        a.available ? el('span', { class: 'app-tick', 'aria-hidden': 'true' }) : null,
      ]));
    });
  }

  // ---------- корзина ----------
  function cart() {
    var sel = [...state.selected].filter(function (s) { var a = appBySlug(s); return a && a.available; });
    var n = sel.length, u = n ? unitPrice(n) : basePrice();
    return { slugs: sel, n: n, unit: u, total: u * n };
  }
  function renderCart() {
    var c = cart(), bar = $('#cartbar');
    bar.hidden = c.n === 0;
    $('#cartCount').textContent = appsWord(c.n) + ' · по ' + rub(c.unit);
    $('#checkoutBtn').textContent = 'Оформить · ' + rub(c.total);
    var next = state.data.tiers.find(function (t) { return t.from > c.n; });
    $('#cartHint').textContent = next ? 'Добавьте ещё ' + (next.from - c.n) + ' — и каждое будет по ' + rub(next.price) : 'Максимальная выгода';
  }
  function changed() { store(); renderApps(); renderTiers(); renderCart(); }

  // ---------- оформление ----------
  function openCheckout() {
    var c = cart(); if (!c.n) return;
    var ul = $('#chosenList'); ul.innerHTML = '';
    c.slugs.forEach(function (s) { ul.appendChild(el('li', { text: appBySlug(s).name })); });
    $('#sumLine').textContent = appsWord(c.n) + ' × ' + rub(c.unit);
    $('#sumTotal').textContent = rub(c.total);
    $('#checkoutErr').hidden = true;
    $('#payBtn').textContent = 'Оплатить ' + rub(c.total);
    var d = $('#checkout'); if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  }
  function showErr(t) { var e = $('#checkoutErr'); e.textContent = t; e.hidden = false; }
  async function pay() {
    var c = cart(), btn = $('#payBtn');
    var contact = $('#contact').value.trim();
    if (contact.length < 3) return showErr('Оставьте Telegram или телефон — напишем, если что-то пойдёт не так.');
    if (!$('#agree').checked) return showErr('Нужно согласие с офертой.');
    btn.disabled = true; btn.textContent = 'Создаём платёж…';
    try {
      var r = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apps: c.slugs, contact: contact, email: $('#email').value.trim(), agree: true }) });
      var j = await r.json();
      if (!j.ok) throw new Error(j.message || 'Не получилось создать заказ.');
      state.selected.clear(); store();
      location.href = j.redirect;
    } catch (e) { showErr(e.message); btn.disabled = false; btn.textContent = 'Оплатить ' + rub(c.total); }
  }

  // ---------- старт ----------
  async function init() {
    restore();
    try {
      var r = await fetch('/api/catalog'); state.data = await r.json();
    } catch (e) { $('#appsGrid').innerHTML = '<p class="muted">Не удалось загрузить каталог. Обновите страницу.</p>'; return; }
    if (state.data.demo) $('#demoBanner').hidden = false;
    if (state.data.support) document.querySelectorAll('a[href^="https://t.me/"]').forEach(function (a) { a.href = 'https://t.me/' + state.data.support; if (a.id === 'supportFaq') a.textContent = '@' + state.data.support; });
    renderSets(); renderTiers(); renderCats(); renderApps(); renderCart();
    $('#search').addEventListener('input', function (e) { state.q = e.target.value; state.cat = 'all'; renderCats(); renderApps(); });
    $('#checkoutBtn').addEventListener('click', openCheckout);
    $('#payBtn').addEventListener('click', pay);
  }
  init();
})();
