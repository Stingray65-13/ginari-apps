// Ginari — установка приложений на iPhone.
// Сервер без внешних зависимостей (Node 18+): витрина, заказы, оплата Platega, выдача через exapplication API.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ---------- настройки ----------
const env = process.env;
const PORT = Number(env.PORT || 3000);
const BASE_URL = (env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const EXAPP_KEY = env.EXAPP_KEY || '';
const EXAPP_WEBHOOK_SECRET = env.EXAPP_WEBHOOK_SECRET || '';
const EXAPP_API = 'https://exapplication.ru/papi/v1';
const PLATEGA_MERCHANT_ID = env.PLATEGA_MERCHANT_ID || '';
const PLATEGA_SECRET = env.PLATEGA_SECRET || '';
const PLATEGA_API = (env.PLATEGA_API || 'https://api.payplatform.cc').replace(/\/$/, '');
// способ оплаты: 2 — СБП (по умолчанию), all — платёжная страница с выбором способа (СБП, карта, крипта…)
const PLATEGA_METHOD = (env.PLATEGA_METHOD || '2').trim();
const TG_BOT_TOKEN = env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = env.TG_CHAT_ID || '';
const SUPPORT_TG = env.SUPPORT_TG || 'ginari_manager';
// Демо-режим: оплата имитируется, страница установки в exapplication НЕ создаётся (деньги не списываются).
const DEMO = env.DEMO === '1' || !(PLATEGA_MERCHANT_ID && PLATEGA_SECRET);
const os = require('node:os');
// Папка для заказов: своя из DATA_DIR, иначе ./data, а если туда нельзя писать (хостинг только для чтения) — временная папка.
function pickDataDir() {
  for (const dir of [env.DATA_DIR, path.join(__dirname, 'data'), path.join(os.tmpdir(), 'ginari-data')].filter(Boolean)) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); return dir; } catch {}
  }
  return null;
}
const DATA_DIR = pickDataDir();
const ROOT = __dirname;

const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog-data.json'), 'utf8'));
const META = new Map(CATALOG.apps.map((a) => [a.slug, a]));

// ---------- хранилище заказов (JSON-файл) ----------
const ORDERS_FILE = DATA_DIR ? path.join(DATA_DIR, 'orders.json') : null;
let orders = {};
try { if (ORDERS_FILE) orders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); } catch { orders = {}; }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!ORDERS_FILE) return;
    try {
      const tmp = ORDERS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(orders, null, 1));
      fs.renameSync(tmp, ORDERS_FILE);
    } catch (e) { log('save error', e.message); }
  }, 50);
}
const byTx = (txId) => Object.values(orders).find((o) => o.platega && o.platega.transactionId === txId);

// ---------- утилиты ----------
const log = (...a) => console.log(new Date().toISOString(), ...a);

// Как exapplication выдаёт ссылки: обычные приложения — на общей странице (до pageSize штук),
// «особые» (ВТБ, ВТБ Инвестиции, Альфа-Банк) — каждое на отдельной странице.
function groupApps(apps) {
  const sep = new Set(CATALOG.separate || []);
  const size = CATALOG.pageSize || 20;
  const common = apps.filter((s) => !sep.has(s));
  const groups = [];
  for (let i = 0; i < common.length; i += size) groups.push(common.slice(i, i + size));
  apps.filter((s) => sep.has(s)).forEach((s) => groups.push([s]));
  return groups;
}

function priceFor(count) {
  const t = CATALOG.tiers.find((x) => count >= x.from && count <= x.to) || CATALOG.tiers[CATALOG.tiers.length - 1];
  return t.price;
}

async function tg(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, disable_web_page_preview: true }),
    });
  } catch (e) { log('tg error', e.message); }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// простое ограничение частоты создания заказов
const hits = new Map();
function rateLimited(ip, max = 10, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now); hits.set(ip, list);
  return list.length > max;
}

// ---------- каталог (наличие — из exapplication) ----------
let catalogCache = { at: 0, ttl: 0, data: null };
let lastGood = null;
const iconSrc = new Map();   // slug -> адрес иконки в exapplication
const iconName = new Map();  // slug -> название (для поиска иконки в App Store)
const iconCache = new Map(); // slug -> { type, buf }
const iconMiss = new Map();  // slug -> время неудачи (повтор через 20 минут)
const iconPending = new Map();
const ICON_DIR = DATA_DIR ? path.join(DATA_DIR, 'icons') : null;
if (ICON_DIR) try { fs.mkdirSync(ICON_DIR, { recursive: true }); } catch (e) {}

function absIconUrl(u) {
  if (!u || typeof u !== 'string') return null;
  try { const x = new URL(u.trim(), 'https://exapplication.ru/'); if (x.protocol === 'http:') x.protocol = 'https:'; return x.protocol === 'https:' ? x.href : null; } catch (e) { return null; }
}
function sniffType(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
  const head = buf.slice(0, 300).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}
async function fetchImage(url, headers) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (GinariIcons)', Accept: 'image/*,*/*;q=0.5', ...(headers || {}) }, signal: AbortSignal.timeout(8000), redirect: 'follow' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 50 || buf.length > 3 * 1024 * 1024) throw new Error('size ' + buf.length);
  const type = sniffType(buf); // по содержимому, а не по заголовку — некоторые CDN отдают картинки как octet-stream
  if (!type) throw new Error('not an image (' + (r.headers.get('content-type') || '?') + ')');
  return { type, buf };
}
const norm = (t) => String(t || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '');
// запасной вариант: иконка из App Store (США/Казахстан — в российском магазине этих приложений как раз нет)
async function appStoreIcon(name) {
  const q = norm(name); if (!q) return null;
  for (const country of ['us', 'kz', 'ru']) {
    try {
      const r = await fetch(`https://itunes.apple.com/search?entity=software&limit=10&country=${country}&term=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const list = ((await r.json()).results || []);
      // строгое совпадение: точно то же название или «Название: …» / «Название Messenger» (для коротких имён — только точное)
      const low = String(name).toLowerCase().replace(/ё/g, 'е').trim();
      const hit = list.find((a) => norm(a.trackName) === q)
        || (q.length >= 4 && list.find((a) => { const t = String(a.trackName || '').toLowerCase().replace(/ё/g, 'е'); return t.startsWith(low) && /^[\s:\-–—|,.(]/.test(t.slice(low.length)); }));
      const art = hit && (hit.artworkUrl512 || hit.artworkUrl100);
      if (art) return await fetchImage(art.replace(/\/\d+x\d+bb\./, '/256x256bb.'));
    } catch (e) { /* пробуем следующую страну */ }
  }
  return null;
}
function iconFile(slug) { return ICON_DIR ? path.join(ICON_DIR, slug + '.bin') : null; }
function loadIconFromDisk(slug) {
  const f = iconFile(slug); if (!f) return null;
  try { const buf = fs.readFileSync(f); const type = sniffType(buf); return type ? { type, buf } : null; } catch (e) { return null; }
}
async function resolveIcon(slug) {
  if (iconCache.has(slug)) return iconCache.get(slug);
  if (iconPending.has(slug)) return iconPending.get(slug);
  const job = (async () => {
    const disk = loadIconFromDisk(slug);
    if (disk) { iconCache.set(slug, disk); return disk; }
    const miss = iconMiss.get(slug); if (miss && Date.now() - miss < 20 * 60 * 1000) return null;
    let ic = null; const src = absIconUrl(iconSrc.get(slug)); const errs = [];
    if (src) {
      try { ic = await fetchImage(src); } catch (e) { errs.push('exapp ' + e.message); }
      if (!ic && EXAPP_KEY && new URL(src).hostname.endsWith('exapplication.ru')) {
        try { ic = await fetchImage(src, { Authorization: `Bearer ${EXAPP_KEY}` }); } catch (e) { errs.push('exapp+key ' + e.message); }
      }
    }
    const over = absIconUrl((CATALOG.iconOverrides || {})[slug]);
    if (!ic && over) { try { ic = await fetchImage(over); } catch (e) { errs.push('override ' + e.message); } }
    if (!ic) { try { ic = await appStoreIcon(iconName.get(slug) || (META.get(slug) || {}).name || slug); if (!ic) errs.push('appstore: не найдено'); } catch (e) { errs.push('appstore ' + e.message); } }
    if (ic) {
      iconCache.set(slug, ic); iconMiss.delete(slug);
      const f = iconFile(slug); if (f) fs.writeFile(f, ic.buf, () => {});
    } else { iconMiss.set(slug, Date.now()); log('icon missing', slug, src || '(нет icon_url)', errs.join('; ')); }
    return ic;
  })();
  iconPending.set(slug, job);
  try { return await job; } finally { iconPending.delete(slug); }
}
// после обновления каталога заранее подтягиваем недостающие иконки, по одной
let warming = false;
async function warmIcons(slugs) {
  if (warming) return; warming = true;
  try { for (const s of slugs) if (!iconCache.has(s)) await resolveIcon(s).catch(() => {}); } finally { warming = false; }
}

async function getCatalog() {
  if (catalogCache.data && Date.now() - catalogCache.at < catalogCache.ttl) return catalogCache.data;
  let remote = null;
  if (EXAPP_KEY) {
    for (let attempt = 0; attempt < 2 && !remote; attempt++) {
      try {
        const r = await fetch(`${EXAPP_API}/apps`, { headers: { Authorization: `Bearer ${EXAPP_KEY}` }, signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        remote = Array.isArray(j) ? j : (j.apps || j.items || null);
        if (!remote) throw new Error('unexpected answer: ' + JSON.stringify(j).slice(0, 200));
      } catch (e) { log('catalog fetch error', e.message); }
    }
    // exapp не ответил — отдаём последний удачный каталог и пробуем снова через 30 секунд
    if (!remote && lastGood) { catalogCache = { at: Date.now(), ttl: 30 * 1000, data: lastGood }; return lastGood; }
  }
  const avail = new Map((remote || []).map((a) => [a.slug, a]));
  const apps = [];
  for (const m of CATALOG.apps) {
    const r = avail.get(m.slug);
    if (remote && !r) continue; // в их каталоге больше нет
    const iu = r && (r.icon_url || r.icon || r.iconUrl || r.image);
    if (iu) iconSrc.set(m.slug, iu);
    iconName.set(m.slug, (r && r.name) || m.name);
    apps.push({ ...m, icon: `/icon/${m.slug}`, available: r ? r.available !== false : true });
  }
  // новые приложения, которых нет в нашем списке
  for (const r of remote || []) {
    if (!META.has(r.slug) && !CATALOG.hidden.includes(r.slug)) {
      const iu = r.icon_url || r.icon || r.iconUrl || r.image;
      if (iu) iconSrc.set(r.slug, iu);
      iconName.set(r.slug, r.name || r.slug);
      apps.push({ slug: r.slug, name: r.name || r.slug, cat: 'other', desc: '', icon: `/icon/${r.slug}`, available: r.available !== false });
    }
  }
  const data = { tiers: CATALOG.tiers, maxApps: CATALOG.maxApps, maxTotal: CATALOG.maxTotal || 10000, separate: CATALOG.separate || [], pageSize: CATALOG.pageSize || 20, categories: CATALOG.categories, sets: CATALOG.sets, apps, demo: DEMO, support: SUPPORT_TG };
  const ok = !EXAPP_KEY || !!remote;
  if (ok && remote) { lastGood = data; setTimeout(() => warmIcons(apps.map((a) => a.slug)), 1000); }
  catalogCache = { at: Date.now(), ttl: ok ? 10 * 60 * 1000 : 30 * 1000, data };
  return data;
}

// ---------- Platega ----------
// Platega требует metadata.user_email — постоянный идентификатор покупателя.
// Есть email — передаём его; нет — стабильный ID из контакта (один и тот же для одного покупателя), как велит их инструкция.
function buyerEmail(order) {
  const e = String(order.email || '').trim().toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e)) return e;
  const c = String(order.contact || '').trim().toLowerCase().replace(/^https?:\/\/t\.me\//, '@').replace(/[\s()-]/g, '');
  return 'g' + crypto.createHash('sha256').update(c || order.id).digest('hex').slice(0, 16) + '@mail.ru';
}
async function plategaCreate(order) {
  // выбор покупателя: СБП (2) или криптовалюта USDT (13); PLATEGA_METHOD=all — страница Platega с выбором
  const universal = PLATEGA_METHOD === 'all';
  const method = order.method === 'usdt' ? 13 : (Number(PLATEGA_METHOD) || 2);
  const body = {
    ...(universal ? {} : { paymentMethod: method }),
    paymentDetails: { amount: order.total, currency: 'RUB' },
    description: `Установка приложений на iPhone (${order.apps.length} шт.), заказ ${order.id.slice(0, 8)}`,
    return: `${BASE_URL}/order/${order.id}`,
    failedUrl: `${BASE_URL}/order/${order.id}?fail=1`,
    payload: order.id,
    metadata: { user_email: buyerEmail(order) },
  };
  const r = await fetch(`${PLATEGA_API}${universal ? '/v2' : ''}/transaction/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-MerchantId': PLATEGA_MERCHANT_ID, 'X-Secret': PLATEGA_SECRET },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  const url = j.redirect || j.url; // /transaction/process отдаёт redirect, /v2/transaction/process — url
  if (!r.ok || !j.transactionId || !url) throw new Error(`platega ${r.status}: ${text.slice(0, 300)}`);
  return { transactionId: j.transactionId, redirect: url };
}
async function plategaStatus(txId) {
  const r = await fetch(`${PLATEGA_API}/transaction/${encodeURIComponent(txId)}`, {
    headers: { 'X-MerchantId': PLATEGA_MERCHANT_ID, 'X-Secret': PLATEGA_SECRET },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`platega status ${r.status}`);
  return r.json();
}

// Сверяем оплату с API Platega и, если всё сходится, выдаём установку.
// Оплату считаем подтверждённой только по ответу API Platega (колбэк — лишь сигнал «проверь»).
const checking = new Set(); // защита от двойной выдачи, если колбэк и проверка со страницы пришли одновременно
async function checkPayment(order) {
  if (DEMO || !order.platega || !['awaiting_payment', 'payment_failed'].includes(order.status)) return;
  if (checking.has(order.id)) return;
  checking.add(order.id);
  order.lastCheck = Date.now();
  try {
    const t = await plategaStatus(order.platega.transactionId);
    if (t.payload && t.payload !== order.id) { log('checkPayment payload mismatch', order.id, t.payload); return; }
    const amount = Number(t.paymentDetails && t.paymentDetails.amount);
    const cur = String((t.paymentDetails && t.paymentDetails.currency) || 'RUB').toUpperCase();
    log('platega status', order.id.slice(0, 8), t.status, amount, cur, t.paymentMethod || '');
    if (t.status === 'CONFIRMED' && ['awaiting_payment', 'payment_failed'].includes(order.status)) {
      // сумму сверяем только в рублях (при оплате USDT Platega может вернуть сумму в USDT)
      if (cur === 'RUB' && amount && Math.round(amount) < order.total) {
        order.status = 'needs_attention'; order.error = `оплачено ${amount}, ожидалось ${order.total}`; save();
        tg(`⚠️ Заказ ${order.id.slice(0, 8)}: сумма оплаты не совпала (${amount} вместо ${order.total}). Проверь вручную.`);
        return;
      }
      order.status = 'paid'; order.paidAt = new Date().toISOString(); save();
      tg(`💳 Оплачен заказ ${order.id.slice(0, 8)} — ${order.total} ₽, ${order.apps.length} прил.\nКонтакт: ${order.contact}`);
      await fulfill(order);
    } else if (['CANCELED', 'FAILED', 'EXPIRED'].includes(t.status) && order.status === 'awaiting_payment') {
      order.status = 'payment_failed'; save();
    }
  } catch (e) { log('checkPayment', order.id, e.message); }
  finally { checking.delete(order.id); }
}

// ---------- exapplication ----------
async function createPage(order, idx, apps) {
  const rid = `${order.id}.${idx}`;
  const r = await fetch(`${EXAPP_API}/pages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${EXAPP_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': rid },
    body: JSON.stringify({ apps, external_id: rid, request_id: rid }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  let j = {}; try { j = JSON.parse(text); } catch (e) {}
  if (!r.ok || !j.token) log('exapp /pages error', order.id.slice(0, 8), idx, r.status, text.slice(0, 400), JSON.stringify(apps));
  return { r, j };
}

async function fulfill(order) {
  if (order.exapp && order.exapp.token) return;               // старые заказы — одна страница
  if (order.fulfilling) return;
  order.fulfilling = true;
  try {
    if (!order.pages) order.pages = groupApps(order.apps).map((apps) => ({ apps }));
    if (DEMO) {
      order.pages.forEach((pg) => { pg.token = 'demo'; pg.demo = true; });
      order.status = 'ready'; save(); return;
    }
    for (let i = 0; i < order.pages.length; i++) {
      const pg = order.pages[i];
      if (pg.token) continue;
      const { r, j } = await createPage(order, i, pg.apps);
      if (r.ok && j.token) {
        Object.assign(pg, { token: j.token, url: j.url, expiresAt: j.expires_at, charged: j.charged });
        save(); log('page created', order.id, i, j.charged, j.balance_after);
        continue;
      }
      order.attempts = (order.attempts || 0) + 1; order.lastAttempt = Date.now();
      order.error = `${r.status} ${typeof j.error === 'object' ? JSON.stringify(j.error) : (j.error || '')} ${j.message || ''}`.trim();
      if (r.status === 402 || order.attempts >= 3) {
        order.status = 'needs_attention'; save();
        if (!order.notified) order.notified = true, tg(`🚨 Заказ ${order.id.slice(0, 8)} оплачен, но установка создана не полностью (${order.pages.filter((x) => x.token).length} из ${order.pages.length}): ${order.error}.\n${r.status === 402 ? 'Пополни баланс exapplication — остальное создастся само при следующей проверке.' : 'Проверь вручную.'}\nКонтакт клиента: ${order.contact}`);
      } else { save(); }
      return;
    }
    order.status = 'ready'; save();
  } catch (e) {
    order.attempts = (order.attempts || 0) + 1; order.lastAttempt = Date.now(); order.error = e.message; save();
    log('fulfill error', order.id, e.message);
  } finally { order.fulfilling = false; }
}

// ---------- статика ----------
const STATIC = {
  '/': 'index.html', '/index.html': 'index.html',
  '/max': 'max.html', '/cart': 'cart.html', '/metrika.js': 'metrika.js', '/theme.js': 'theme.js',
  '/offer': 'offer.html', '/privacy': 'privacy.html', '/consent': 'consent.html',
  '/app.js': 'app.js', '/order.js': 'order.js', '/styles.css': 'styles.css',
  '/catalog-data.json': 'catalog-data.json',
  '/logo.png': 'logo.png', '/logo-light.png': 'logo-light.png', '/bg.svg': 'bg.svg', '/favicon.svg': 'favicon.svg', '/favicon.png': 'favicon.png',
  '/robots.txt': 'robots.txt',
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https://mc.yandex.ru https://mc.yandex.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-src https://exapplication.ru https://mc.yandex.ru https://mc.yandex.com; connect-src 'self' https://mc.yandex.ru https://mc.yandex.com wss://mc.yandex.ru wss://mc.yandex.com; script-src 'self' https://mc.yandex.ru https://yastatic.net; frame-ancestors 'none'",
};
function serveFile(res, file) {
  const p = path.join(ROOT, file);
  fs.readFile(p, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream', 'Cache-Control': /\.(html|css|js|json)$/.test(file) ? 'no-cache' : 'public, max-age=3600', ...SECURITY_HEADERS });
    res.end(buf);
  });
}

// ---------- маршруты ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE_URL);
  const p = url.pathname;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (req.method === 'GET' && STATIC[p]) return serveFile(res, STATIC[p]);
    if (req.method === 'GET' && /^\/order\/[A-Za-z0-9_-]{16,64}$/.test(p)) return serveFile(res, 'order.html');

    const im = p.match(/^\/icon\/([a-z0-9-]{1,40})$/);
    if (req.method === 'GET' && im) {
      const slug = im[1];
      if (!iconName.has(slug)) await getCatalog();
      if (!iconName.has(slug) && !META.has(slug)) return send(res, 404, 'Not found');
      const ic = await resolveIcon(slug);
      if (!ic) return send(res, 404, 'Not found');
      res.writeHead(200, { 'Content-Type': ic.type, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
      return res.end(ic.buf);
    }

    if (req.method === 'GET' && p === '/api/catalog') return send(res, 200, await getCatalog());

    if (req.method === 'POST' && p === '/api/orders') {
      if (rateLimited(ip)) return send(res, 429, { ok: false, message: 'Слишком много заказов подряд. Попробуйте позже.' });
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const cat = await getCatalog();
      const allowed = new Map(cat.apps.map((a) => [a.slug, a]));
      const apps = [...new Set(Array.isArray(body.apps) ? body.apps.map(String) : [])];
      if (!apps.length) return send(res, 400, { ok: false, message: 'Выберите хотя бы одно приложение.' });
      if (apps.length > CATALOG.maxApps) return send(res, 400, { ok: false, message: `В один заказ помещается до ${CATALOG.maxApps} приложений. Оформите этот заказ, а остальные приложения — вторым заказом.` });
      const bad = apps.filter((s) => !allowed.has(s) || !allowed.get(s).available);
      if (bad.length) return send(res, 400, { ok: false, message: 'Некоторые приложения сейчас недоступны. Обновите страницу.' });
      const contact = String(body.contact || '').trim().slice(0, 100);
      if (contact.length < 3) return send(res, 400, { ok: false, message: 'Оставьте Telegram или телефон для связи.' });
      if (!body.agree) return send(res, 400, { ok: false, message: 'Нужно согласие с офертой.' });

      const unit = priceFor(apps.length);
      const maxTotal = CATALOG.maxTotal || 10000;
      if (unit * apps.length > maxTotal) return send(res, 400, { ok: false, message: `Сумма одного заказа — до ${maxTotal.toLocaleString('ru-RU')} ₽. Оформите этот заказ, а остальные приложения — вторым заказом.` });
      const order = {
        id: crypto.randomBytes(18).toString('base64url'),
        createdAt: new Date().toISOString(),
        apps, unit, total: unit * apps.length,
        contact, email: String(body.email || '').trim().slice(0, 100),
        method: body.method === 'usdt' ? 'usdt' : 'sbp',
        status: 'awaiting_payment',
      };
      orders[order.id] = order; save();

      if (DEMO) {
        order.status = 'paid'; order.paidAt = order.createdAt; save();
        await fulfill(order);
        return send(res, 200, { ok: true, redirect: `/order/${order.id}` });
      }
      try {
        const t = await plategaCreate(order);
        order.platega = { transactionId: t.transactionId, redirect: t.redirect }; save();
        return send(res, 200, { ok: true, redirect: t.redirect });
      } catch (e) {
        log('platega create error', e.message);
        order.status = 'payment_failed'; order.error = e.message; save();
        return send(res, 502, { ok: false, message: 'Платёжный сервис сейчас не отвечает. Попробуйте ещё раз через минуту.' });
      }
    }

    const m = p.match(/^\/api\/orders\/([A-Za-z0-9_-]{16,64})$/);
    if (req.method === 'GET' && m) {
      const order = orders[m[1]];
      if (!order) return send(res, 404, { ok: false });
      if (order.status === 'awaiting_payment' && (!order.lastCheck || Date.now() - order.lastCheck > 8000)) await checkPayment(order);
      if (order.status === 'paid' && !order.fulfilling && (!order.lastTry || Date.now() - order.lastTry > 15000)) { order.lastTry = Date.now(); await fulfill(order); }
      if (order.status === 'needs_attention' && order.error && /402/.test(order.error) && (!order.lastTry || Date.now() - order.lastTry > 60000)) {
        order.lastTry = Date.now(); order.status = 'paid'; order.attempts = 0; await fulfill(order);
      }
      const names = order.apps.map((s) => (META.get(s) || { name: s }).name);
      return send(res, 200, {
        ok: true, status: order.status, apps: names, unit: order.unit, total: order.total,
        payRedirect: order.status === 'awaiting_payment' && order.platega ? order.platega.redirect : null,
        embed: order.status === 'ready' && order.exapp && !order.exapp.demo ? `https://exapplication.ru/papi/v1/embed/${order.exapp.token}` : null,
        pages: order.status === 'ready' || order.status === 'needs_attention' ? (order.pages || []).filter((pg) => pg.token).map((pg) => ({
          apps: pg.apps.map((s) => (META.get(s) || { name: s }).name),
          embed: pg.demo ? null : `https://exapplication.ru/papi/v1/embed/${pg.token}`,
          status: pg.installStatus || null,
        })) : [],
        demo: !!((order.exapp && order.exapp.demo) || (order.pages || []).some((pg) => pg.demo)),
        installStatus: order.installStatus || null,
        support: SUPPORT_TG,
      });
    }

    // Колбэк Platega: проверяем заголовки, отвечаем сразу, статус сверяем через API.
    if (req.method === 'POST' && p === '/api/platega/callback') {
      const raw = await readBody(req);
      // при сохранении адреса в кабинете Platega шлёт пустой POST и ждёт 200
      if (!raw.length || !raw.toString('utf8').trim() || raw.toString('utf8').trim() === '{}') return send(res, 200, { ok: true });
      if (DEMO || !PLATEGA_SECRET) return send(res, 503, { ok: false });
      if (!safeEqual(req.headers['x-merchantid'] || '', PLATEGA_MERCHANT_ID) || !safeEqual(req.headers['x-secret'] || '', PLATEGA_SECRET)) { log('platega callback: wrong headers'); return send(res, 401, { ok: false }); }
      let j = {}; try { j = JSON.parse(raw.toString('utf8')); } catch {}
      const txId = j.id || j.Id || j.transactionId;
      const order = (txId && byTx(txId)) || (typeof j.payload === 'string' && Object.prototype.hasOwnProperty.call(orders, j.payload) && orders[j.payload].platega ? orders[j.payload] : null) || null;
      log('platega callback', txId, j.status, order ? order.id.slice(0, 8) : 'заказ не найден');
      send(res, 200, { ok: true }); // отвечаем сразу (у них таймаут 60 с), дальше сверяем статус через API
      if (!order) return;
      if (['CHARGEBACKED', 'PARTIALLY_REFUNDED', 'DISPUTED'].includes(j.status) && !['awaiting_payment', 'payment_failed'].includes(order.status)) {
        const key = `${j.status}:${j.refundId || ''}`;
        order.plategaEvents = order.plategaEvents || [];
        if (!order.plategaEvents.includes(key)) { order.plategaEvents.push(key); save(); tg(`↩️ Заказ ${order.id.slice(0, 8)}: Platega прислала ${j.status} (${j.amount || ''} ${j.currency || ''}). Проверь в кабинете.`); }
        return;
      }
      await checkPayment(order);
      return;
    }

    // Вебхук exapplication: подпись HMAC-SHA256(secret, body).
    if (req.method === 'POST' && p === '/api/exapp/webhook') {
      const raw = await readBody(req);
      if (!EXAPP_WEBHOOK_SECRET) return send(res, 503, { ok: false });
      const mac = crypto.createHmac('sha256', EXAPP_WEBHOOK_SECRET).update(raw).digest('hex');
      if (!safeEqual(req.headers['x-signature'] || '', mac)) return send(res, 401, { ok: false });
      send(res, 200, { ok: true });
      let ev = {}; try { ev = JSON.parse(raw.toString('utf8')); } catch {}
      if (ev.event === 'balance.low') { tg(`💰 Баланс exapplication ниже порога: ${ev.balance} ₽. Пополни, иначе новые заказы не создадутся.`); return; }
      const [oid, pidx] = String(ev.external_id || '').split('.');
      const order = oid && orders[oid];
      if (order) {
        const pg = order.pages && pidx != null ? order.pages[Number(pidx)] : null;
        if (pg) pg.installStatus = ev.event;
        const all = order.pages ? order.pages.every((x) => x.installStatus === 'page.done') : true;
        order.installStatus = pg && ev.event === 'page.done' && !all ? 'page.code' : ev.event; save();
        if (order.installStatus === 'page.done') tg(`✅ Заказ ${order.id.slice(0, 8)}: клиент всё установил.`);
        if (ev.event === 'page.expired') tg(`⌛ Заказ ${order.id.slice(0, 8)}: страница истекла. Контакт: ${order.contact}`);
      }
      return;
    }

    if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true, demo: DEMO });
    return send(res, 404, 'Not found');
  } catch (e) {
    log('error', p, e.stack || e.message);
    if (!res.headersSent) send(res, 500, { ok: false, message: 'Ошибка сервера. Попробуйте ещё раз.' });
  }
});

// Фоновая проверка неоплаченных/невыданных заказов (если колбэк не дошёл).
setInterval(() => {
  const now = Date.now();
  for (const o of Object.values(orders)) {
    const age = now - Date.parse(o.createdAt);
    if (o.status === 'awaiting_payment' && age < 60 * 60 * 1000 && (!o.lastCheck || now - o.lastCheck > 60000)) checkPayment(o);
    if (o.status === 'paid' && !o.fulfilling) fulfill(o);
    // оплачено, но установка не создалась (нет денег у exapp, сбой) — пробуем снова каждые 3 минуты в течение суток
    if (o.status === 'needs_attention' && o.paidAt && !o.fulfilling && !/^оплачено/.test(o.error || '') && now - Date.parse(o.paidAt) < 24 * 3600 * 1000 && (!o.lastAttempt || now - o.lastAttempt > 3 * 60 * 1000)) {
      o.lastAttempt = now; o.status = 'paid'; o.attempts = 0; fulfill(o);
    }
  }
}, 30000).unref();

server.listen(PORT, () => log(`Ginari apps on ${BASE_URL} (port ${PORT}, data: ${DATA_DIR || 'память'})${DEMO ? ' — ДЕМО-РЕЖИМ: оплата имитируется, установки не создаются' : ''}`));
