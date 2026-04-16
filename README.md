# Telegram bot (Vercel) — минимальный старт

Бот отвечает **"привет"** на команду **/start**. Реализовано через **webhook** (подходит для Vercel).

## Переменные окружения

- `TELEGRAM_BOT_TOKEN` — токен от `@BotFather`
- (опционально) `TELEGRAM_WEBHOOK_SECRET` — секрет для проверки заголовка `X-Telegram-Bot-Api-Secret-Token`
- (опционально) `START_RULES_TEXT` — текст правил, который показывается на `/start`
- `REQUIRED_CHANNELS` — каналы-партнеры (через запятую, например `@channel1,@channel2,@channel3`); без подписки генерация недоступна
- `HF_TOKEN` — токен Hugging Face (нужен для генерации картинок командой `/img`)
- (опционально) `HF_TEXT_TO_IMAGE_MODEL` — модель для text-to-image (по умолчанию `black-forest-labs/FLUX.1-schnell`)
- (опционально) `HF_ENDPOINT_URL` — явный endpoint Hugging Face Router (например `https://router.huggingface.co/hf-inference/models/<model>`)
- `IMG_STYLE_PROMPT` — фиксированный промпт-стиль для обработки фото (по умолчанию `В мире дикой природы`)
- (опционально) `HF_IMAGE_TO_IMAGE_MODEL` — модель для image-to-image (по умолчанию `FireRedTeam/FireRed-Image-Edit-1.0`)
- (опционально) `HF_IMAGE_PROVIDERS` — приоритет провайдеров для обработки фото (через запятую), напр. `wavespeed,replicate,fal-ai`

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
