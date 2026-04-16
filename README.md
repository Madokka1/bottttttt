# Telegram bot (Vercel) — минимальный старт

Бот отвечает **"привет"** на команду **/start**. Реализовано через **webhook** (подходит для Vercel).

## Переменные окружения

- `TELEGRAM_BOT_TOKEN` — токен от `@BotFather`
- (опционально) `TELEGRAM_WEBHOOK_SECRET` — секрет для проверки заголовка `X-Telegram-Bot-Api-Secret-Token`
- (опционально) `START_RULES_TEXT` — текст правил, который показывается на `/start`
- `REQUIRED_CHANNELS` — каналы-партнеры (через запятую, например `@channel1,@channel2,@channel3`); без подписки генерация недоступна
- `HORDE_API_KEY` — ключ AI Horde (можно не задавать: используется анонимный `0000000000`, но с более жёсткими лимитами)
- (опционально) `HORDE_BASE_URLS` — базовые URL через запятую (фолбэки), напр. `https://aihorde.net/api/v2,https://stablehorde.net/api/v2`
- (опционально) `HORDE_MODELS` — список моделей через запятую (если пусто, Horde выбирает сам)
- (опционально) `HORDE_STEPS`, `HORDE_WIDTH`, `HORDE_HEIGHT`, `HORDE_DENOISING`, `HORDE_TIMEOUT_MS` — настройки качества/скорости
- (опционально) `HORDE_HTTP_TIMEOUT_MS`, `HORDE_SUBMIT_HTTP_TIMEOUT_MS`, `HORDE_CHECK_HTTP_TIMEOUT_MS` — таймауты HTTP (если видишь aborted/timeout — увеличь `HORDE_SUBMIT_HTTP_TIMEOUT_MS`)
- `IMG_STYLE_PROMPT` — фиксированный промпт-стиль для обработки фото (по умолчанию `В мире дикой природы`)

## Команды

- `/start` → `привет`
- `/img` → попросит прислать фото, обработает его в стиле из `IMG_STYLE_PROMPT`
- `/t2i <промпт>` → генерирует картинку по тексту и отправляет её

## Деплой на Vercel

1. Залей репозиторий в GitHub/GitLab/Bitbucket.
2. Импортируй проект в Vercel.
3. В **Project Settings → Environment Variables** добавь `TELEGRAM_BOT_TOKEN`, `HF_TOKEN` (и при желании `TELEGRAM_WEBHOOK_SECRET`).
4. Задеплой.

Webhook URL будет таким:

`https://<твое-имя-проекта>.vercel.app/api/telegram`

## Установка webhook

На локальной машине:

```bash
export TELEGRAM_BOT_TOKEN="..."
# опционально:
export TELEGRAM_WEBHOOK_SECRET="..."

npm run set-webhook -- "https://<твое-имя-проекта>.vercel.app/api/telegram"
```

## Быстрая проверка

Открой в браузере:

`https://<твое-имя-проекта>.vercel.app/api/telegram`

Должно вернуть `{ "ok": true, "service": "telegram-webhook" }`.
