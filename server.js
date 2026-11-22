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
const PLATEGA_API = (env.PLATEGA_API || 'https://app.platega.io').replace(/\/$/, '');
const TG_BOT_TOKEN = env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = env.TG_CHAT_ID || '';
const SUPPORT_TG = env.SUPPORT_TG || 'ginari_manager';
// Демо-режим: оплата имитируется, страница установки в exapplication НЕ создаётся (деньги не списываются).
const DEMO = env.DEMO === '1' || !(PLATEGA_MERCHANT_ID && PLATEGA_SECRET);
const DATA_DIR = env.DATA_DIR || path.join(__dirname, 'data');
const ROOT = __dirname;

const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog-data.json'), 'utf8'));
const META = new Map(CATALOG.apps.map((a) => [a.slug, a]));

// ---------- хранилище заказов (JSON-файл) ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
let orders = {};
try { orders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); } catch { orders = {}; }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = ORDERS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(orders, null, 1));
    fs.renameSync(tmp, ORDERS_FILE);
  }, 50);
}
const byTx = (txId) => Object.values(orders).find((o) => o.platega && o.platega.transactionId === txId);

// ---------- утилиты ----------
const log = (...a) => console.log(new Date().toISOString(), ...a);

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
let catalogCache = { at: 0, data: null };
const iconSrc = new Map();   // slug -> адрес иконки в exapplication
const iconCache = new Map(); // slug -> { type, buf }
async function getCatalog() {
  if (catalogCache.data && Date.now() - catalogCache.at < 10 * 60 * 1000) return catalogCache.data;
  let remote = null;
  if (EXAPP_KEY) {
    try {
      const r = await fetch(`${EXAPP_API}/apps`, { headers: { Authorization: `Bearer ${EXAPP_KEY}` } });
      const j = await r.json();
      remote = Array.isArray(j) ? j : (j.apps || j.items || null);
    } catch (e) { log('catalog fetch error', e.message); }
  }
  const avail = new Map((remote || []).map((a) => [a.slug, a]));
  const apps = [];
  for (const m of CATALOG.apps) {
    const r = avail.get(m.slug);
    if (remote && !r) continue; // в их каталоге больше нет
    if (r && r.icon_url) iconSrc.set(m.slug, r.icon_url);
    apps.push({ ...m, icon: iconSrc.has(m.slug) ? `/icon/${m.slug}` : null, available: r ? r.available !== false : true });
  }
  // новые приложения, которых нет в нашем списке
  for (const r of remote || []) {
    if (!META.has(r.slug) && !CATALOG.hidden.includes(r.slug)) {
      if (r.icon_url) iconSrc.set(r.slug, r.icon_url);
      apps.push({ slug: r.slug, name: r.name || r.slug, cat: 'other', desc: '', icon: r.icon_url ? `/icon/${r.slug}` : null, available: r.available !== false });
    }
  }
  const data = { tiers: CATALOG.tiers, maxApps: CATALOG.maxApps, categories: CATALOG.categories, sets: CATALOG.sets, apps, demo: DEMO, support: SUPPORT_TG };
  catalogCache = { at: Date.now(), data };
  return data;
}

// ---------- Platega ----------
async function plategaCreate(order) {
  const r = await fetch(`${PLATEGA_API}/v2/transaction/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-MerchantId': PLATEGA_MERCHANT_ID, 'X-Secret': PLATEGA_SECRET },
    body: JSON.stringify({
      paymentDetails: { amount: order.total, currency: 'RUB' },
      description: `Установка приложений на iPhone (${order.apps.length} шт.), заказ ${order.id.slice(0, 8)}`,
      return: `${BASE_URL}/order/${order.id}`,
      failedUrl: `${BASE_URL}/order/${order.id}?fail=1`,
      payload: order.id,
    }),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (!r.ok || !j.redirect) throw new Error(`platega ${r.status}: ${text.slice(0, 300)}`);
  return j;
}

async function plategaStatus(txId) {
  const r = await fetch(`${PLATEGA_API}/transaction/${encodeURIComponent(txId)}`, {
    headers: { 'X-MerchantId': PLATEGA_MERCHANT_ID, 'X-Secret': PLATEGA_SECRET },
  });
  if (!r.ok) throw new Error(`platega status ${r.status}`);
  return r.json();
}

// Сверяем оплату с API Platega и, если всё сходится, выдаём установку.
async function checkPayment(order) {
  if (DEMO || !order.platega || order.status !== 'awaiting_payment') return;
  order.lastCheck = Date.now();
  try {
    const t = await plategaStatus(order.platega.transactionId);
    const amount = Number(t.paymentDetails && t.paymentDetails.amount);
    if (t.status === 'CONFIRMED') {
      if (amount && Math.round(amount) < order.total) {
        order.status = 'needs_attention'; order.error = `оплачено ${amount}, ожидалось ${order.total}`; save();
        tg(`⚠️ Заказ ${order.id.slice(0, 8)}: сумма оплаты не совпала (${amount} вместо ${order.total}). Проверь вручную.`);
        return;
      }
      order.status = 'paid'; order.paidAt = new Date().toISOString(); save();
      tg(`💳 Оплачен заказ ${order.id.slice(0, 8)} — ${order.total} ₽, ${order.apps.length} прил.\nКонтакт: ${order.contact}`);
      await fulfill(order);
    } else if (['CANCELED', 'FAILED', 'EXPIRED'].includes(t.status)) {
      order.status = 'payment_failed'; save();
    }
  } catch (e) { log('checkPayment', order.id, e.message); }
}

// ---------- exapplication ----------
async function fulfill(order) {
  if (order.exapp && order.exapp.token) return;
  if (order.fulfilling) return;
  order.fulfilling = true;
  try {
    if (DEMO) {
      order.exapp = { token: 'demo', demo: true };
      order.status = 'ready'; save(); return;
    }
    const r = await fetch(`${EXAPP_API}/pages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${EXAPP_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': order.id },
      body: JSON.stringify({ apps: order.apps, external_id: order.id, request_id: order.id }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.token) {
      order.exapp = { token: j.token, url: j.url, expiresAt: j.expires_at, charged: j.charged, balanceAfter: j.balance_after };
      order.status = 'ready'; save();
      log('fulfilled', order.id, j.charged, j.balance_after);
      return;
    }
    order.attempts = (order.attempts || 0) + 1;
    order.error = `${r.status} ${j.error || ''} ${j.message || ''}`.trim();
    if (r.status === 402 || order.attempts >= 3) {
      order.status = 'needs_attention'; save();
      tg(`🚨 Заказ ${order.id.slice(0, 8)} оплачен, но установка НЕ создана: ${order.error}.\n${r.status === 402 ? 'Пополни баланс exapplication — заказ создастся сам при следующей проверке.' : 'Проверь вручную.'}\nКонтакт клиента: ${order.contact}`);
    } else { save(); }
  } catch (e) {
    order.attempts = (order.attempts || 0) + 1; order.error = e.message; save();
    log('fulfill error', order.id, e.message);
  } finally { order.fulfilling = false; }
}

// ---------- статика ----------
const STATIC = {
  '/': 'index.html', '/index.html': 'index.html',
  '/offer': 'offer.html', '/privacy': 'privacy.html', '/consent': 'consent.html',
  '/app.js': 'app.js', '/order.js': 'order.js', '/styles.css': 'styles.css',
  '/catalog-data.json': 'catalog-data.json',
  '/logo.png': 'logo.png', '/favicon.svg': 'favicon.svg', '/favicon.png': 'favicon.png',
  '/robots.txt': 'robots.txt',
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-src https://exapplication.ru; connect-src 'self'; script-src 'self'; frame-ancestors 'none'",
};
function serveFile(res, file) {
  const p = path.join(ROOT, file);
  fs.readFile(p, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream', 'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600', ...SECURITY_HEADERS });
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
      if (!iconSrc.size) await getCatalog();
      let ic = iconCache.get(slug);
      const src = iconSrc.get(slug);
      if (!ic && src && /^https:\/\/exapplication\.ru\//.test(src)) {
        try {
          const r = await fetch(src);
          const type = r.headers.get('content-type') || 'image/png';
          if (r.ok && /^image\//.test(type)) { ic = { type, buf: Buffer.from(await r.arrayBuffer()) }; iconCache.set(slug, ic); }
        } catch (e) { log('icon error', slug, e.message); }
      }
      if (!ic) return send(res, 404, 'Not found');
      res.writeHead(200, { 'Content-Type': ic.type, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
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
      if (apps.length > CATALOG.maxApps) return send(res, 400, { ok: false, message: `Не больше ${CATALOG.maxApps} приложений в одном заказе.` });
      const bad = apps.filter((s) => !allowed.has(s) || !allowed.get(s).available);
      if (bad.length) return send(res, 400, { ok: false, message: 'Некоторые приложения сейчас недоступны. Обновите страницу.' });
      const contact = String(body.contact || '').trim().slice(0, 100);
      if (contact.length < 3) return send(res, 400, { ok: false, message: 'Оставьте Telegram или телефон для связи.' });
      if (!body.agree) return send(res, 400, { ok: false, message: 'Нужно согласие с офертой.' });

      const unit = priceFor(apps.length);
      const order = {
        id: crypto.randomBytes(18).toString('base64url'),
        createdAt: new Date().toISOString(),
        apps, unit, total: unit * apps.length,
        contact, email: String(body.email || '').trim().slice(0, 100),
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
        demo: !!(order.exapp && order.exapp.demo),
        installStatus: order.installStatus || null,
        support: SUPPORT_TG,
      });
    }

    // Колбэк Platega: проверяем заголовки, отвечаем сразу, статус сверяем через API.
    if (req.method === 'POST' && p === '/api/platega/callback') {
      const raw = await readBody(req);
      if (DEMO || !PLATEGA_SECRET) return send(res, 503, { ok: false });
      if (!safeEqual(req.headers['x-merchantid'] || '', PLATEGA_MERCHANT_ID) || !safeEqual(req.headers['x-secret'] || '', PLATEGA_SECRET)) return send(res, 401, { ok: false });
      send(res, 200, { ok: true });
      let j = {}; try { j = JSON.parse(raw.toString('utf8')); } catch {}
      const order = j.id && byTx(j.id);
      if (order) await checkPayment(order);
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
      const order = ev.external_id && orders[ev.external_id];
      if (order) {
        order.installStatus = ev.event; save();
        if (ev.event === 'page.done') tg(`✅ Заказ ${order.id.slice(0, 8)}: клиент всё установил.`);
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
  }
}, 30000).unref();

server.listen(PORT, () => log(`Ginari apps on ${BASE_URL} (port ${PORT})${DEMO ? ' — ДЕМО-РЕЖИМ: оплата имитируется, установки не создаются' : ''}`));
