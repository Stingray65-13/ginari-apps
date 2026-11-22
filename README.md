# Ginari — установка приложений на iPhone

Витрина + сервер без внешних зависимостей (Node.js 18+). Запуск: `node server.js`.

## Переменные окружения
| Переменная | Что это |
|---|---|
| `BASE_URL` | Адрес сайта, например `https://ginari.tech` (нужен для возврата после оплаты) |
| `EXAPP_KEY` | API-ключ exapplication (`exa_856f0759fdba596f8494e687ee733d34`) |
| `EXAPP_WEBHOOK_SECRET` | Secret вебхука из карточки ключа exapplication |
| `PLATEGA_MERCHANT_ID` | MerchantId из кабинета Platega |
| `PLATEGA_SECRET` | API-ключ (X-Secret) из кабинета Platega |
| `TG_BOT_TOKEN`, `TG_CHAT_ID` | Уведомления в Telegram (необязательно) |
| `SUPPORT_TG` | Ник поддержки без @, по умолчанию `ginari_manager` |
| `DATA_DIR` | Папка для файла заказов, по умолчанию `./data` |

Пока не заданы ключи Platega, сайт работает в **демо-режиме**: оплата имитируется, установки в exapplication не создаются и деньги не списываются.

## Адреса для настройки
- Колбэк Platega: `BASE_URL/api/platega/callback`
- Вебхук exapplication: `BASE_URL/api/exapp/webhook`
