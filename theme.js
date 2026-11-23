/* Тема (тёмная/светлая) и счётчик корзины в шапке. Подключается в <head>, чтобы не мигало. */
(function () {
  'use strict';
  var KEY = 'ginari_theme', root = document.documentElement;
  function saved() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function current() { return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }
  function apply(t) {
    root.setAttribute('data-theme', t);
    var m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', t === 'light' ? '#F4F1EB' : '#0C1214');
    sync();
  }
  function sync() {
    var t = current();
    // логотип: светлый на тёмном фоне, тёмный на светлом (первый экран всегда тёмный)
    document.querySelectorAll('img[data-logo]').forEach(function (i) { var want = t === 'light' ? '/logo.png' : '/logo-light.png'; if (i.getAttribute('src') !== want) i.setAttribute('src', want); });
    document.querySelectorAll('[data-theme-set]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-theme-set') === t)); });
    var tg = document.getElementById('themeToggle'); if (tg) tg.setAttribute('aria-label', t === 'light' ? 'Включить тёмную тему' : 'Включить светлую тему');
  }
  function set(t) { try { localStorage.setItem(KEY, t); } catch (e) {} apply(t); }
  apply(saved() === 'light' ? 'light' : 'dark');

  // счётчик в шапке для страниц без каталога (app.js обновляет его сам по актуальным данным)
  function badgeFromStorage() {
    var b = document.getElementById('cartBadge'); if (!b || window.__ginariCart) return;
    var n = 0; try { n = (JSON.parse(localStorage.getItem('ginari_sel') || '[]') || []).length; } catch (e) {}
    b.textContent = n; b.hidden = !n;
  }

  document.addEventListener('DOMContentLoaded', function () {
    sync(); badgeFromStorage();
    var tg = document.getElementById('themeToggle');
    if (tg) tg.addEventListener('click', function () { set(current() === 'light' ? 'dark' : 'light'); });
    document.querySelectorAll('[data-theme-set]').forEach(function (b) { b.addEventListener('click', function () { set(b.getAttribute('data-theme-set')); }); });
  });
  window.addEventListener('storage', function (e) { if (e.key === KEY && e.newValue) apply(e.newValue === 'light' ? 'light' : 'dark'); if (e.key === 'ginari_sel') badgeFromStorage(); });
})();
