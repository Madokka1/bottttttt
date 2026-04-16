# Telegram bot (Vercel) — минимальный старт

Бот отвечает **"привет"** на команду **/start**. Реализовано через **webhook** (подходит для Vercel).

## Переменные окружения

- `TELEGRAM_BOT_TOKEN` — токен от `@BotFather`
- (опционально) `TELEGRAM_WEBHOOK_SECRET` — секрет для проверки заголовка `X-Telegram-Bot-Api-Secret-Token`
- `HF_TOKEN` — токен Hugging Face (нужен для генерации картинок командой `/img`)
- (опционально) `HF_TEXT_TO_IMAGE_MODEL` — модель для text-to-image (по умолчанию `runwayml/stable-diffusion-v1-5`)
- (опционально) `HF_ENDPOINT_URL` — явный endpoint Hugging Face Router (например `https://router.huggingface.co/hf-inference/models/<model>`)

## Команды

- `/start` → `привет`
- `/img <промпт>` → генерирует картинку и отправляет её

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
