/**
 * Журнал заказов ginari.tech → эта Google Таблица.
 * Сайт присылает POST с изменёнными заказами (одна строка на заказ, обновляется по номеру),
 * а после перезапуска забирает GET-ом незавершённые заказы последних дней.
 *
 * Настройка: Проект → Настройки проекта → Свойства скрипта → SECRET = длинная случайная строка
 * (та же, что ORDERS_SHEET_SECRET в Timeweb). Развернуть → Веб-приложение:
 * «Запуск от имени: я», «Доступ: все». Ссылку /exec вписать в ORDERS_SHEET_URL в Timeweb.
 */
var SHEET_NAME = 'Заказы';
var COLS = [
  ['short', 'Заказ'], ['created', 'Создан (МСК)'], ['paid', 'Оплачен (МСК)'], ['status', 'Статус'],
  ['apps', 'Приложения'], ['count', 'Кол-во'], ['unit', 'Цена за шт, ₽'], ['total', 'Сумма, ₽'],
  ['method', 'Способ оплаты'], ['paid_amount', 'Пришло от Platega'], ['platega_id', 'ID платежа Platega'],
  ['links', 'Ссылки установки'], ['install', 'Статус установки'], ['error', 'Ошибка'],
  ['contact', 'Контакт'], ['email', 'Email'], ['id', 'Полный номер'], ['updated', 'Обновлено (МСК)'], ['data', 'data (служебное)']
];

function secretOk_(s) {
  var want = PropertiesService.getScriptProperties().getProperty('SECRET');
  return want && s === want;
}
function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(COLS.map(function (c) { return c[1]; }));
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, COLS.length).setFontWeight('bold');
    sh.hideColumns(COLS.length); // служебный JSON
  }
  return sh;
}
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function nowMsk_() { return Utilities.formatDate(new Date(), 'Europe/Moscow', 'yyyy-MM-dd HH:mm:ss'); }

function doPost(e) {
  var body; try { body = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'bad json' }); }
  if (!secretOk_(body.secret)) return out_({ ok: false, error: 'forbidden' });
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var sh = sheet_();
    var idCol = COLS.map(function (c) { return c[0]; }).indexOf('id') + 1;
    var last = sh.getLastRow();
    var ids = last > 1 ? sh.getRange(2, idCol, last - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];
    (body.rows || []).forEach(function (row) {
      row.updated = nowMsk_();
      var values = [COLS.map(function (c) { var v = row[c[0]]; return v === undefined || v === null ? '' : v; })];
      var i = ids.indexOf(String(row.id));
      if (i >= 0) sh.getRange(i + 2, 1, 1, COLS.length).setValues(values);
      else { sh.getRange(sh.getLastRow() + 1, 1, 1, COLS.length).setValues(values); ids.push(String(row.id)); }
    });
    return out_({ ok: true, n: (body.rows || []).length });
  } finally { lock.releaseLock(); }
}

// Заказы, созданные за последние N дней (по умолчанию 3) — сайт подтягивает их после перезапуска.
function doGet(e) {
  if (!secretOk_(e.parameter.secret)) return out_({ ok: false, error: 'forbidden' });
  var days = Number(e.parameter.days || 3);
  var sh = sheet_(), last = sh.getLastRow();
  if (last < 2) return out_({ ok: true, rows: [] });
  var keys = COLS.map(function (c) { return c[0]; });
  var vals = sh.getRange(2, 1, last - 1, COLS.length).getValues();
  var since = Date.now() - days * 86400000, rows = [];
  vals.forEach(function (v) {
    var data = v[keys.indexOf('data')];
    try { var o = JSON.parse(data); if (Date.parse(o.createdAt) >= since) rows.push({ id: o.id, data: data }); } catch (err) {}
  });
  return out_({ ok: true, rows: rows });
}
