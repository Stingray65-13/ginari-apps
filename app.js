(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  window.__ginariCart = true;
  var state = { data: null, selected: new Set(), cat: 'all', q: '', ops: {} };
  var COLORS = { net: '#3B4A5A', other: '#5A6468', gov: '#2C5AA0', banks: '#1E5963', social: '#2F4A6D', media: '#B56A52', telecom: '#4F6B5B', life: '#7A6450', ai: '#0B0F10' };
  var rub = function (n) { return n.toLocaleString('ru-RU') + ' ₽'; };
  var plural = function (n, a, b, c) { var m = n % 10, h = n % 100; return (m === 1 && h !== 11) ? a : (m >= 2 && m <= 4 && (h < 10 || h >= 20)) ? b : c; };
  var appsWord = function (n) { return n + ' ' + plural(n, 'приложение', 'приложения', 'приложений'); };

  function goal(n) { try { if (window.ginariGoal) window.ginariGoal(n); } catch (e) {} }
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
    var g = $('#setsGrid'); if (!g) return; g.innerHTML = '';
    state.data.sets.forEach(function (set) {
      var apps = setApps(set); var n = apps.length; if (!n) return;
      var price = unitPrice(n) * n, old = basePrice() * n;
      var names = apps.map(function (s) { return appBySlug(s).name; }).join(' · ');
      var ops = null;
      if (set.operator) {
        var cur = state.ops[set.id] || set.apps[0];
        ops = el('div', { class: 'op-select', 'aria-label': 'Ваш оператор' }, availableSlugs(set.operator).map(function (s) {
          return el('button', { type: 'button', 'aria-pressed': String(s === cur), text: appBySlug(s).name, onclick: function () { state.ops[set.id] = s; renderSets(); renderHero(); } });
        }));
      }
      g.appendChild(el('article', { class: 'set' + (set.featured ? ' featured' : '') }, [
        el('div', { class: 'set-top' }, [el('h3', { text: set.name }), set.featured ? el('span', { class: 'set-tag', text: 'выгоднее всего' }) : null]),
        el('p', { class: 'muted', style: 'margin:0', text: set.note }),
        ops,
        el('div', { class: 'set-icons', 'aria-hidden': 'true' }, apps.map(function (s) { return icon(appBySlug(s)); })),
        el('p', { class: 'set-apps', text: names }),
        el('div', { class: 'set-price' }, [
          el('b', { text: rub(price) }),
          old > price ? el('span', { class: 'old', text: rub(old) }) : null,
          old > price ? el('span', { class: 'save', text: 'выгода ' + rub(old - price) }) : null,
          el('span', { class: 'muted small', text: n + ' × ' + rub(unitPrice(n)) }),
        ]),
        el('div', { class: 'set-actions' }, [
          el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: 'Выбрать набор', onclick: function () { addSet(apps); openCheckout(); } }),
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Изменить состав', onclick: function () { addSet(apps); $('#catalog').scrollIntoView(); } }),
        ]),
      ]));
    });
  }


  // ---------- первый экран ----------
  var heroIdx = 0;
  function setBySlug(id) { return state.data.sets.find(function (x) { return x.id === id; }); }
  function addSet(apps) { for (var i = 0; i < apps.length; i++) { if (state.selected.has(apps[i])) continue; if (!canAdd()) break; state.selected.add(apps[i]); } changed(); }
  function renderMini(id, setId) {
    var b = $(id), set = setBySlug(setId); if (!b || !set) return;
    var apps = setApps(set), n = apps.length;
    b.innerHTML = '';
    b.setAttribute('aria-label', 'Выбрать набор «' + set.name + '» — ' + rub(unitPrice(n) * n));
    b.appendChild(el('span', { class: 'tm-title', text: set.name }));
    b.appendChild(el('span', { class: 'tm-art' }, [
      el('span', { class: 'tm-icons' }, apps.slice(0, 6).map(function (s) { return icon(appBySlug(s)); })),
    ]));
    b.appendChild(el('span', { class: 'tm-foot' }, [
      el('span', { class: 'tm-price', text: rub(unitPrice(n) * n) }),
      el('span', { class: 'round', 'aria-hidden': 'true', text: '+' }),
    ]));
    b.onclick = function () { addSet(apps); openCheckout(); };
  }
  function renderHero() {
    var box = $('#heroSet'); if (!box) return;
    var sets = state.data.sets.filter(function (s) { return setApps(s).length; });
    if (!sets.length) return;
    heroIdx = (heroIdx + sets.length) % sets.length;
    var set = sets[heroIdx], apps = setApps(set), n = apps.length, price = unitPrice(n) * n, old = basePrice() * n;
    box.innerHTML = '';
    var main = el('div', { class: 'th-main' }, [
      el('span', { class: 'th-tag', text: set.featured ? 'Выгоднее всего' : 'Набор' }),
      el('h2', { class: 'th-name', text: set.name }),
      el('p', { class: 'th-note', text: set.note }),
      el('div', { class: 'th-icons' }, apps.slice(0, 12).map(function (s) { var i = icon(appBySlug(s)); i.title = appBySlug(s).name; return i; })),
      el('div', { class: 'th-foot' }, [
        el('div', { class: 'th-price' }, [el('b', { text: rub(price) }), old > price ? el('span', { class: 'old', text: rub(old) }) : null]),
        el('div', { class: 'th-nav' }, [
          el('button', { type: 'button', class: 'round', 'aria-label': 'Предыдущий набор', text: '‹', onclick: function () { heroIdx--; renderHero(); } }),
          el('button', { type: 'button', class: 'round', 'aria-label': 'Следующий набор', text: '›', onclick: function () { heroIdx++; renderHero(); } }),
        ]),
        el('button', { type: 'button', class: 'round light', 'aria-label': 'Выбрать набор «' + set.name + '»', text: '+', onclick: function () { addSet(apps); openCheckout(); } }),
      ]),
    ]);
    var used = {};
    var thumbs = el('div', { class: 'th-thumbs', role: 'tablist', 'aria-label': 'Наборы' }, sets.map(function (s, i) {
      var list = setApps(s), pick = list.find(function (x) { return !used[x]; }) || list[0]; used[pick] = 1;
      var first = appBySlug(pick);
      return el('button', { type: 'button', class: 'th-thumb', role: 'tab', 'aria-pressed': String(i === heroIdx), 'aria-label': s.name, title: s.name, onclick: function () { heroIdx = i; renderHero(); } }, [icon(first)]);
    }));
    box.appendChild(main); box.appendChild(thumbs);
  }

  // ---------- сетка цен ----------
  function renderTiers() {
    var n = state.selected.size, t = $('#tiers'); if (!t) return; t.innerHTML = '';
    state.data.tiers.forEach(function (x) {
      var label = x.to >= state.data.maxApps ? 'от ' + x.from + ' приложений' : x.from + '–' + x.to + ' ' + plural(x.to, 'приложение', 'приложения', 'приложений');
      t.appendChild(el('div', { class: 'tier' + (n >= x.from && n <= x.to ? ' active' : '') }, [el('b', { text: rub(x.price) }), el('span', { text: label })]));
    });
  }

  // ---------- каталог ----------
  function renderCats() {
    var c = $('#cats'); if (!c) return; c.innerHTML = '';
    var cats = [{ id: 'all', name: 'Все' }].concat(state.data.categories.filter(function (k) { return state.data.apps.some(function (a) { return a.cat === k.id; }); }));
    cats.forEach(function (k) {
      c.appendChild(el('button', { type: 'button', role: 'tab', 'aria-selected': String(state.cat === k.id), text: k.name, onclick: function () { state.cat = k.id; renderCats(); renderApps(); } }));
    });
  }
  function renderApps() {
    var g = $('#appsGrid'); if (!g) return; g.innerHTML = '';
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
        onclick: function () { if (!a.available) return; if (on) state.selected.delete(a.slug); else if (canAdd()) state.selected.add(a.slug); changed(); },
      }, [
        icon(a),
        el('span', { class: 'app-txt' }, [el('b', {}, [a.name, a.badge ? el('span', { class: 'app-badge', text: a.badge }) : null]), el('span', { text: a.available ? (a.desc || '') : 'временно недоступно' })]),
        a.available ? el('span', { class: 'app-tick', 'aria-hidden': 'true' }) : null,
      ]));
    });
  }

  function letter(a) { return el('span', { class: 'app-ico', style: 'background:' + (COLORS[a.cat] || '#1E5963'), text: a.name.replace(/^[^A-Za-zА-Яа-яЁё0-9]+/, '').charAt(0).toUpperCase() }); }
  function icon(a) {
    if (!a.icon || a.icon.indexOf('/icon/') !== 0) return letter(a);
    var img = el('img', { class: 'app-ico app-img', src: a.icon, alt: '', width: '42', height: '42', decoding: 'async' });
    img.addEventListener('error', function () { img.replaceWith(letter(a)); });
    return img;
  }

  // ---------- корзина ----------
  function cart() {
    var sel = [...state.selected].filter(function (s) { var a = appBySlug(s); return a && a.available; });
    var n = sel.length, u = n ? unitPrice(n) : basePrice();
    return { slugs: sel, n: n, unit: u, total: u * n, full: basePrice() * n };
  }
  // как exapplication разложит заказ по ссылкам: обычные — общая страница (до pageSize), особые — отдельные
  function linkPlan(slugs) {
    var sep = state.data.separate || [], size = state.data.pageSize || 20;
    var special = slugs.filter(function (s) { return sep.indexOf(s) >= 0; });
    var common = slugs.length - special.length, commonPages = Math.ceil(common / size);
    return { common: common, commonPages: commonPages, special: special, total: commonPages + special.length };
  }
  function renderBadge(c) {
    var b = $('#cartBadge'); if (!b) return;
    var prev = +b.textContent || 0;
    b.textContent = c.n; b.hidden = !c.n;
    var cb = $('#cartBtn');
    if (cb && c.n > prev && renderBadge.ready) { cb.classList.remove('bump'); void cb.offsetWidth; cb.classList.add('bump'); }
    renderBadge.ready = true;
    var btn = $('#cartBtn'); if (btn) btn.setAttribute('aria-label', 'Корзина: ' + appsWord(c.n));
  }
  function renderCart() {
    var c = cart();
    renderBadge(c);
    var bar = $('#cartbar');
    if (bar) {
      bar.hidden = c.n === 0;
      $('#cartCount').textContent = appsWord(c.n) + ' · по ' + rub(c.unit);
      $('#checkoutBtn').textContent = 'Оформить · ' + rub(c.total);
      var next = state.data.tiers.find(function (t) { return t.from > c.n; });
      $('#cartHint').textContent = next ? 'Добавьте ещё ' + (next.from - c.n) + ' — и каждое будет по ' + rub(next.price) : 'Максимальная выгода';
    }
    renderCartPage();
  }
  function changed() { store(); renderApps(); renderTiers(); renderCart(); }

  // ---------- страница корзины /cart ----------
  var SUGGEST = ['max', 'sber', 't-bank', 'gosuslugi', 'vtb', 'alfa-bank', 'ozon-bank', 'vk', 'avito', 'chatgpt', 'kinopoisk'];
  function suggestNote(a) {
    if (a.slug === 'max') return 'Мессенджер, которого нет в App Store';
    if (a.cat === 'banks') return 'Ещё один банк — на всякий случай';
    if (a.slug === 'gosuslugi') return 'Документы, штрафы, запись к врачу';
    return a.desc || '';
  }
  function renderCartPage() {
    var root = $('#cartPage'); if (!root) return;
    var c = cart(), has = c.n > 0;
    $('#cartEmpty').hidden = has;
    root.querySelectorAll('.cart-needs-items').forEach(function (x) { x.hidden = !has; });

    // состав
    var list = $('#cartList'); list.innerHTML = '';
    c.slugs.forEach(function (s) {
      var a = appBySlug(s);
      list.appendChild(el('li', { class: 'ci' }, [
        icon(a),
        el('span', { class: 'ci-txt' }, [el('b', { text: a.name }), el('span', { text: '1 iPhone' })]),
        el('b', { class: 'ci-price', text: rub(c.unit) }),
        el('button', { type: 'button', class: 'ci-del', 'aria-label': 'Убрать ' + a.name, text: '×', onclick: function () { state.selected.delete(s); changed(); } }),
      ]));
    });

    // ссылки
    var p = linkPlan(c.slugs), parts = [];
    if (p.common) parts.push((p.commonPages > 1 ? p.commonPages + ' общие на ' : 'общая на ') + appsWord(p.common));
    if (p.special.length) parts.push((p.special.length > 1 ? 'отдельные на ' : 'отдельная на ') + p.special.map(function (s) { return appBySlug(s).name; }).join(', '));
    $('#linksCount').textContent = p.total;
    $('#linksWord').textContent = plural(p.total, 'ссылку', 'ссылки', 'ссылок');
    $('#linksSub').textContent = parts.join(' + ');

    // цена
    $('#priceNow').textContent = rub(c.unit);
    var next = state.data.tiers.find(function (t) { return t.from > c.n; });
    var hint = $('#priceHint'); hint.innerHTML = '';
    if (next && has) {
      var nn = next.from;
      hint.append('Добавьте ещё ' + appsWord(next.from - c.n) + ' — каждое станет по ', el('b', { text: rub(next.price) }),
        '. ' + appsWord(nn) + ': ' + rub(next.price * nn) + ' вместо ' + rub(c.unit * nn) + ' — на ' + rub(c.unit * nn - next.price * nn) + ' меньше');
    } else if (has) {
      hint.append('Лучшая цена: ', el('b', { text: rub(c.unit) }), ' за каждое' + (c.full > c.total ? '. Экономия ' + rub(c.full - c.total) : ''));
    }
    var tiers = $('#cartTiers'); tiers.innerHTML = '';
    state.data.tiers.forEach(function (x) {
      var label = x.to >= state.data.maxApps ? 'от ' + x.from + ' приложений' : x.from + '–' + x.to + ' ' + plural(x.to, 'приложение', 'приложения', 'приложений');
      var on = c.n >= x.from && c.n <= x.to;
      tiers.appendChild(el('div', { class: 'ct' + (on ? ' on' : c.n > x.to ? ' past' : '') }, [el('i', { 'aria-hidden': 'true' }), el('b', { text: rub(x.price) }), el('span', { text: label })]));
    });
    $('#selCount').textContent = appsWord(c.n);
    $('#selTotal').textContent = rub(c.total);

    // с этим часто берут
    var sg = $('#suggest'); sg.innerHTML = '';
    SUGGEST.filter(function (s) { var a = appBySlug(s); return a && a.available && !state.selected.has(s); }).slice(0, 3).forEach(function (s) {
      var a = appBySlug(s), price = unitPrice(c.n + 1);
      sg.appendChild(el('div', { class: 'sg' }, [
        icon(a), el('b', { text: a.name }), el('span', { class: 'muted small', text: suggestNote(a) }),
        el('div', { class: 'sg-foot' }, [el('span', { text: rub(price) }),
          el('button', { type: 'button', class: 'round', 'aria-label': 'Добавить ' + a.name, text: '+', onclick: function () { if (canAdd()) { state.selected.add(s); changed(); } } })]),
      ]));
    });
    $('#suggestWrap').hidden = !sg.children.length || !has;

    // к оплате
    $('#payCount').textContent = appsWord(c.n);
    $('#payTotal').textContent = rub(c.total);
    var saveSum = c.full - c.total;
    $('#paySave').textContent = saveSum > 0 ? 'экономия ' + rub(saveSum) : '';
    var rows = $('#payRows'); rows.innerHTML = '';
    var row = function (l, r, cls) { rows.appendChild(el('div', { class: 'pr' + (cls ? ' ' + cls : '') }, [el('span', { text: l }), el('b', { text: r })])); };
    row(appsWord(c.n), 'по ' + rub(c.unit));
    if (saveSum > 0) { row('Без скидки', rub(c.full)); row('Скидка за количество', '−' + rub(saveSum), 'good'); }
    var btn = $('#payBtn');
    if (!btn.dataset.busy) { btn.disabled = !has; btn.textContent = has ? 'Оплатить ' + rub(c.total) : 'Корзина пуста'; }
  }

  // ---------- лимит одного заказа (не показываем заранее, только при упоре) ----------
  function limitFor(n) {
    var maxApps = state.data.maxApps || 20, maxTotal = state.data.maxTotal || 10000;
    if (n > maxApps) return 'В один заказ помещается до ' + maxApps + ' приложений. Оформите этот заказ, а остальные приложения — вторым заказом.';
    if (unitPrice(n) * n > maxTotal) return 'Сумма одного заказа — до ' + rub(maxTotal) + '. Оформите этот заказ, а остальные приложения — вторым заказом.';
    return '';
  }
  function canAdd() { var msg = limitFor(cart().n + 1); if (msg) { notice(msg); return false; } return true; }
  var noticeTimer;
  function notice(text) {
    var n = $('#limitNotice');
    if (!n) { n = el('div', { id: 'limitNotice', class: 'limit-notice', role: 'status' }); document.body.appendChild(n); }
    n.textContent = text; n.classList.add('show');
    clearTimeout(noticeTimer); noticeTimer = setTimeout(function () { n.classList.remove('show'); }, 5000);
  }

  // ---------- оформление ----------
  function openCheckout() { store(); if (location.pathname !== '/cart') location.href = '/cart'; }
  function showErr(t) { var e = $('#checkoutErr'); e.textContent = t; e.hidden = false; }
  async function pay() {
    var c = cart(), btn = $('#payBtn');
    if (!c.n) return;
    $('#checkoutErr').hidden = true;
    var contact = $('#contact').value.trim();
    if (contact.length < 3) return showErr('Оставьте Telegram или телефон — напишем, если что-то пойдёт не так.');
    if (!$('#agree').checked) return showErr('Нужно согласие с офертой.');
    btn.disabled = true; btn.dataset.busy = '1'; btn.textContent = 'Создаём платёж…';
    try {
      var r = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apps: c.slugs, contact: contact, email: $('#email').value.trim(), agree: true }) });
      var j = await r.json();
      if (!j.ok) throw new Error(j.message || 'Не получилось создать заказ.');
      state.selected.clear(); store();
      goal('order_create');
      setTimeout(function () { location.href = j.redirect; }, 250);
    } catch (e) { showErr(e.message); delete btn.dataset.busy; btn.disabled = false; btn.textContent = 'Оплатить ' + rub(c.total); }
  }

  // ---------- старт ----------
  async function init() {
    restore();
    try {
      var r = await fetch('/api/catalog'); state.data = await r.json();
    } catch (e) { var g0 = $('#appsGrid'); if (g0) g0.innerHTML = '<p class="muted">Не удалось загрузить каталог. Обновите страницу.</p>'; return; }
    var mx = appBySlug('max'); if (mx && mx.icon) document.querySelectorAll('.mq-ico, .max-ico').forEach(function (i) { i.addEventListener('load', function () { i.hidden = false; }); i.addEventListener('error', function () { i.hidden = true; }); i.src = mx.icon; });
    function buyMax(src) { var a = appBySlug('max'); if (a && a.available) { goal(src); addSet(['max']); openCheckout(); } }
    var mq = $('#maxMarquee'); if (mq) mq.addEventListener('click', function () { buyMax('max_banner'); });
    document.querySelectorAll('.js-buy-max').forEach(function (b) { b.addEventListener('click', function () { buyMax('max_cta'); }); });
    var add = (location.search.match(/[?&]add=([a-z0-9-]+)/) || [])[1];
    if (add && appBySlug(add)) { addSet([add]); openCheckout(); }
    if (state.data.support) document.querySelectorAll('a[href^="https://t.me/"]').forEach(function (a) { a.href = 'https://t.me/' + state.data.support; if (a.id === 'supportFaq') a.textContent = '@' + state.data.support; });
    renderHero(); renderMini('#miniA', 'banks'); renderMini('#miniB', 'media'); renderSets(); renderTiers(); renderCats(); renderApps(); renderCart();
    if ($('#search')) $('#search').addEventListener('input', function (e) { state.q = e.target.value; state.cat = 'all'; renderCats(); renderApps(); });
    if ($('#checkoutBtn')) $('#checkoutBtn').addEventListener('click', openCheckout);
    if ($('#payBtn')) $('#payBtn').addEventListener('click', pay);
    if ($('#cartPage') && cart().n) goal('checkout_open');
  }
  init();
})();
