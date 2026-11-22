(function () {
  'use strict';
  var root = document.getElementById('root');
  var id = location.pathname.split('/').pop();
  var failedReturn = /[?&]fail=1/.test(location.search);
  var rendered = '';
  var rub = function (n) { return n.toLocaleString('ru-RU') + ' ₽'; };

  function h(html) { if (html !== rendered) { root.innerHTML = html; rendered = html; } }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function supportBtn(o) { return '<a class="btn btn-ghost btn-wide" href="https://t.me/' + esc(o.support) + '" target="_blank" rel="noopener">Написать в поддержку</a>'; }
  function summary(o) { return '<p class="muted" style="margin:6px 0 0">' + o.apps.map(esc).join(' · ') + '</p><p style="margin:10px 0 0"><b>' + rub(o.total) + '</b> <span class="muted">(' + o.apps.length + ' × ' + rub(o.unit) + ')</span></p>'; }

  function paidGoal(o) { if (o.status !== 'paid' && o.status !== 'ready' && o.status !== 'needs_attention') return; try { var k = 'ginari_paid_' + id; if (localStorage.getItem(k)) return; localStorage.setItem(k, '1'); } catch (e) {} try { if (window.ginariGoal) window.ginariGoal('order_paid', { order_price: o.total, currency: 'RUB' }); } catch (e) {} }
  function render(o) {
    paidGoal(o);
    document.querySelectorAll('.support-link').forEach(function (a) { a.href = 'https://t.me/' + o.support; });
    if (o.status === 'awaiting_payment') {
      return h('<div class="order-card"><h1><span class="status-dot"></span>Ждём оплату</h1>' + summary(o) +
        '<p class="muted">Если вы уже оплатили — подождите несколько секунд, страница обновится сама.</p>' +
        (o.payRedirect ? '<a class="btn btn-primary btn-wide" href="' + esc(o.payRedirect) + '">Перейти к оплате</a>' : '') + '</div>');
    }
    if (o.status === 'payment_failed') {
      return h('<div class="order-card"><h1>Оплата не прошла</h1>' + summary(o) +
        '<p>Деньги не списаны. Можно собрать заказ заново.</p><a class="btn btn-primary btn-wide" href="/#catalog">Вернуться к выбору</a></div>');
    }
    if (o.status === 'paid') {
      return h('<div class="order-card"><h1><span class="status-dot"></span>Оплата получена</h1>' + summary(o) +
        '<p>Готовим установку — это несколько секунд.</p></div>');
    }
    if (o.status === 'needs_attention') {
      return h('<div class="order-card"><h1>Оплата получена</h1>' + summary(o) +
        '<p>Установка готовится чуть дольше обычного. Мы уже получили уведомление и напишем вам. Если хочется быстрее — напишите в поддержку, ответим сразу.</p>' + supportBtn(o) + '</div>');
    }
    if (o.status === 'ready') {
      var done = o.installStatus === 'page.done', expired = o.installStatus === 'page.expired';
      var head = '<div class="order-card"><h1>' + (done ? 'Готово — всё установлено' : expired ? 'Срок страницы истёк' : 'Можно устанавливать') + '</h1>' + summary(o) +
        (expired ? '<p>Если что-то не успели поставить — напишите в поддержку, продлим.</p>' + supportBtn(o) :
          '<ol class="tips"><li>Откройте эту страницу <b>на iPhone</b>, куда ставите приложения.</li><li>Входите в аккаунт <b>только в App Store</b> (раздел «Контент и покупки»), не в iCloud.</li><li>Ставьте сразу: страница действует около двух часов.</li></ol>') + '</div>';
      if (o.demo) return h(head + '<div class="demo-box"><b>Демо-режим</b><p>Здесь появится установка в стиле Ginari: данные для входа, таймер, код подтверждения и кнопки. Сейчас оплата не подключена, поэтому настоящая установка не создаётся.</p></div>');
      if (!o.embed) return h(head + supportBtn(o));
      return h(head + '<iframe class="embed" src="' + esc(o.embed) + '" title="Установка приложений" allow="clipboard-write"></iframe>' +
        '<p class="muted small center" style="margin-top:14px">Сохраните ссылку на эту страницу — по ней можно вернуться к установке.</p>');
    }
    h('<div class="order-card"><h1>Что-то пошло не так</h1>' + supportBtn(o) + '</div>');
  }

  var delay = 3000;
  async function tick() {
    try {
      var r = await fetch('/api/orders/' + encodeURIComponent(id), { cache: 'no-store' });
      if (r.status === 404) return h('<div class="order-card"><h1>Заказ не найден</h1><p>Проверьте ссылку или напишите в поддержку.</p><a class="btn btn-primary btn-wide" href="/">На главную</a></div>');
      var o = await r.json();
      if (failedReturn && o.status === 'awaiting_payment') o.status = 'payment_failed';
      render(o);
      if (o.status === 'ready' && o.installStatus === 'page.done') return;
      delay = o.status === 'ready' ? 20000 : 3000;
    } catch (e) { delay = 6000; }
    setTimeout(tick, delay);
  }
  tick();
})();
