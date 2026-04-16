function getJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve(null);
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function getHordeApiKey() {
  // Anonymous key is allowed by AI Horde, but has stricter limits.
  return (process.env.HORDE_API_KEY || "0000000000").trim();
}

function getHordeBaseUrl() {
  return (process.env.HORDE_BASE_URL || "https://stablehorde.net/api/v2").replace(/\/+$/, "");
}

async function telegramApi(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  const json = await resp.json().catch(() => null);
  if (!resp.ok || !json?.ok) {
    const details = json ? JSON.stringify(json) : String(resp.status);
    throw new Error(`Telegram API error: ${details}`);
  }
  return json.result;
}

async function telegramApiMultipart(method, formData) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    body: formData
  });

  const json = await resp.json().catch(() => null);
  if (!resp.ok || !json?.ok) {
    const details = json ? JSON.stringify(json) : String(resp.status);
    throw new Error(`Telegram API error: ${details}`);
  }
  return json.result;
}

function isStartCommand(text) {
  if (!text) return false;
  // /start or /start <payload> or /start@botname
  return /^\/start(\s|$|@)/i.test(text.trim());
}

function mainMenuReplyMarkup() {
  return {
    keyboard: [[{ text: "Сгенерировать" }, { text: "Партнеры" }]],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

let botInfoCache = null;
async function getBotInfo() {
  if (botInfoCache) return botInfoCache;
  botInfoCache = await telegramApi("getMe", {});
  return botInfoCache;
}

function getStartRulesText() {
  const rules = (process.env.START_RULES_TEXT || "").trim();
  if (rules) return rules;
  return "Правила:\n1) Не спамить\n2) Не отправлять запрещенный контент";
}

function parseCommand(text, command) {
  if (!text) return null;
  const trimmed = text.trim();
  const match = trimmed.match(new RegExp(`^\\/${command}(?:@[^\\s]+)?(?:\\s+([\\s\\S]+))?$`, "i"));
  if (!match) return null;
  return (match[1] ?? "").trim();
}

const PENDING_TTL_MS = 5 * 60 * 1000;
const pendingImageByChatId = new Map();

function prunePending(now) {
  for (const [chatId, expiresAt] of pendingImageByChatId.entries()) {
    if (expiresAt <= now) pendingImageByChatId.delete(chatId);
  }
}

function setPending(chatId, now) {
  prunePending(now);
  pendingImageByChatId.set(String(chatId), now + PENDING_TTL_MS);
}

function isPending(chatId, now) {
  prunePending(now);
  const expiresAt = pendingImageByChatId.get(String(chatId));
  return typeof expiresAt === "number" && expiresAt > now;
}

function clearPending(chatId) {
  pendingImageByChatId.delete(String(chatId));
}

function parseRequiredChannels() {
  const raw = (process.env.REQUIRED_CHANNELS || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith("@") ? s : `@${s}`));
}

function isSubscribedStatus(status) {
  return status === "creator" || status === "administrator" || status === "member";
}

async function getSubscriptionStatus(channelUsername, userId) {
  const member = await telegramApi("getChatMember", {
    chat_id: channelUsername,
    user_id: userId
  });
  return member?.status;
}

async function checkRequiredSubscriptions(userId) {
  void userId;
  // Temporarily disabled: always allow.
  return { ok: true, channels: [] };
}

function partnersText(channelsStatus) {
  if (!channelsStatus.length) return "Партнеры не настроены (REQUIRED_CHANNELS).";

  const lines = ["Чтобы пользоваться генерацией, подпишись на партнеров:"];
  for (const item of channelsStatus) {
    const mark = item.ok ? "✅" : "❌";
    const link = `https://t.me/${item.channel.replace(/^@/, "")}`;
    lines.push(`${mark} ${item.channel} — ${link}`);
  }
  lines.push("");
  lines.push("После подписки нажми кнопку «Сгенерировать» ещё раз.");
  lines.push("");
  lines.push("Важно: бот должен иметь доступ к проверке подписки (обычно нужно добавить бота админом в канал).");
  return lines.join("\n");
}

async function blobToBase64(blob) {
  const ab = await blob.arrayBuffer();
  return Buffer.from(ab).toString("base64");
}

function parseCommaList(value) {
  const raw = (value || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function hordeFetch(path, init) {
  const url = `${getHordeBaseUrl()}${path}`;
  const headers = {
    ...(init?.headers || {}),
    apikey: getHordeApiKey(),
    "content-type": "application/json"
  };
  const resp = await fetch(url, { ...init, headers });
  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    const details = json ? JSON.stringify(json) : String(resp.status);
    const err = new Error(`AI Horde error: ${details}`);
    err.httpStatus = resp.status;
    err.httpBody = json ?? details;
    err.httpUrl = url;
    throw err;
  }
  return json;
}

function formatHttpError(err) {
  const status = err?.httpStatus;
  const url = err?.httpUrl;
  const body = err?.httpBody;
  const msg = typeof err?.message === "string" ? err.message : String(err);

  let bodyText = "";
  if (typeof body === "string") bodyText = body;
  else if (body && typeof body === "object") {
    const candidate =
      typeof body.message === "string"
        ? body.message
        : typeof body.error === "string"
          ? body.error
          : typeof body.detail === "string"
            ? body.detail
            : "";
    bodyText = candidate || JSON.stringify(body);
  }

  const header = `${typeof status === "number" ? `HTTP ${status}` : ""}${url ? ` | ${url}` : ""}`.trim();
  const extra = bodyText ? `\n${bodyText}` : "";
  const hint =
    status === 429
      ? "\n\nПодсказка: лимит AI Horde исчерпан, попробуй через минуту или используй свой HORDE_API_KEY."
      : "";
  return `${header ? header + "\n" : ""}${msg}${extra}${hint}`.slice(0, 3500);
}

async function hordeGenerate({ prompt, sourceImageBlob }) {
  const models = parseCommaList(process.env.HORDE_MODELS);
  const steps = Number(process.env.HORDE_STEPS || 20);
  const width = Number(process.env.HORDE_WIDTH || 512);
  const height = Number(process.env.HORDE_HEIGHT || 512);
  const denoisingStrength = Number(process.env.HORDE_DENOISING || 0.6);

  const payload = {
    prompt,
    params: {
      n: 1,
      steps: Number.isFinite(steps) ? steps : 20,
      width: Number.isFinite(width) ? width : 512,
      height: Number.isFinite(height) ? height : 512
    },
    r2: false,
    censor_nsfw: true,
    trusted_workers: false
  };

  if (models.length) payload.models = models;

  if (sourceImageBlob) {
    payload.source_processing = "img2img";
    payload.source_image = await blobToBase64(sourceImageBlob);
    payload.params.denoising_strength = Number.isFinite(denoisingStrength) ? denoisingStrength : 0.6;
  }

  const submit = await hordeFetch("/generate/async", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  const id = submit?.id;
  if (!id) throw new Error("AI Horde: missing job id");

  const timeoutMs = Number(process.env.HORDE_TIMEOUT_MS || 25000);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const check = await hordeFetch(`/generate/check/${id}`, { method: "GET" });
    if (check?.done === true) {
      const status = await hordeFetch(`/generate/status/${id}`, { method: "GET" });
      const gen = status?.generations?.[0];
      const b64 = gen?.img;
      if (!b64) throw new Error("AI Horde: generation finished but no image data");
      // Stable Horde returns WEBP base64 by default
      const bytes = Buffer.from(b64, "base64");
      return new Blob([bytes], { type: "image/webp" });
    }
    await sleep(1500);
  }

  const err = new Error("AI Horde: timed out waiting for generation");
  err.httpStatus = 504;
  err.httpBody = { id };
  err.httpUrl = `${getHordeBaseUrl()}/generate/check/${id}`;
  throw err;
}

async function generateImage(prompt) {
  return await hordeGenerate({ prompt });
}

async function stylizePhoto(inputImageBlob) {
  const stylePrompt = (process.env.IMG_STYLE_PROMPT || "В мире дикой природы").trim();
  const prompt =
    "Отредактируй изображение в стилистике: " +
    stylePrompt +
    ". Сохрани композицию, но сделай общий стиль соответствующим.";
  return await hordeGenerate({ prompt, sourceImageBlob: inputImageBlob });
}

function guessFileNameFromMime(mimeType) {
  const t = (mimeType || "").toLowerCase();
  if (t.includes("png")) return "image.png";
  if (t.includes("jpeg") || t.includes("jpg")) return "image.jpg";
  if (t.includes("webp")) return "image.webp";
  return "image.bin";
}

function formatHfError(err) {
  return formatHttpError(err);
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function downloadTelegramPhotoAsBlob(fileId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  const file = await telegramApi("getFile", { file_id: fileId });
  const filePath = file?.file_path;
  if (!filePath) throw new Error("Telegram getFile returned no file_path");

  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download Telegram file: HTTP ${resp.status}`);
  return await resp.blob();
}

async function answerCallbackQuery(id) {
  if (!id) return;
  try {
    await telegramApi("answerCallbackQuery", { callback_query_id: id });
  } catch (err) {
    console.error("answerCallbackQuery failed:", err);
  }
}

module.exports = async (req, res) => {
  try {
    if (req.method === "GET") {
      return sendJson(res, 200, { ok: true, service: "telegram-webhook" });
    }

    if (req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    }

    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (expectedSecret) {
      const gotSecret = req.headers["x-telegram-bot-api-secret-token"];
      if (gotSecret !== expectedSecret) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" });
      }
    }

    const update = await getJsonBody(req);
    const message = update?.message ?? update?.edited_message;
    if (message?.chat?.id) {
      const chatId = message.chat.id;
      const now = Date.now();
      const userId = message?.from?.id;

      // 1) Text commands
      if (typeof message.text === "string") {
        const text = message.text;

        if (isStartCommand(text)) {
          const botInfo = await getBotInfo();
          const botName = botInfo?.first_name || botInfo?.username || "бот";
          const rulesText = getStartRulesText();
          await telegramApi("sendMessage", {
            chat_id: chatId,
            text: `Это бот ${botName}.\n\n${rulesText}`,
            reply_markup: mainMenuReplyMarkup()
          });
        } else {
          if (text.trim() === "Сгенерировать") {
            if (!userId) {
              await telegramApi("sendMessage", { chat_id: chatId, text: "Не вижу user_id :(" });
              return sendJson(res, 200, { ok: true });
            }

            const subs = await checkRequiredSubscriptions(userId);
            if (!subs.ok) {
              await telegramApi("sendMessage", { chat_id: chatId, text: partnersText(subs.channels) });
              return sendJson(res, 200, { ok: true });
            }

            setPending(chatId, now);
            const stylePrompt = (process.env.IMG_STYLE_PROMPT || "В мире дикой природы").trim();
            await telegramApi("sendMessage", {
              chat_id: chatId,
              text:
                "Пришли фото, я обработаю его в стиле:\n" +
                stylePrompt +
                "\n\nМожно просто отправить фото следующим сообщением.",
              reply_markup: mainMenuReplyMarkup()
            });
          } else if (text.trim() === "Партнеры") {
            if (!userId) {
              await telegramApi("sendMessage", { chat_id: chatId, text: "Не вижу user_id :(" });
              return sendJson(res, 200, { ok: true });
            }

            const subs = await checkRequiredSubscriptions(userId);
            await telegramApi("sendMessage", {
              chat_id: chatId,
              text: partnersText(subs.channels)
            });
          }

          const imgCmd = parseCommand(text, "img");
          if (imgCmd !== null) {
            // /img triggers photo stylization flow (fixed prompt)
            setPending(chatId, now);
            const stylePrompt = (process.env.IMG_STYLE_PROMPT || "В мире дикой природы").trim();
            await telegramApi("sendMessage", {
              chat_id: chatId,
              text:
                "Ок! Пришли фото, я обработаю его в стиле:\n" +
                stylePrompt +
                "\n\nМожно просто отправить фото следующим сообщением."
            });
          } else {
            const t2iPrompt = parseCommand(text, "t2i");
            if (t2iPrompt !== null) {
              if (!t2iPrompt) {
                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: "Использование: /t2i <что нарисовать>"
                });
              } else {
                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: "Генерирую изображение…"
                });

                try {
                  const imageBlob = await generateImage(t2iPrompt);
                  const fileName = guessFileNameFromMime(imageBlob.type);

                  const form = new FormData();
                  form.append("chat_id", String(chatId));
                  form.append("photo", imageBlob, fileName);
                  form.append("caption", t2iPrompt.slice(0, 1024));

                  await telegramApiMultipart("sendPhoto", form);
                } catch (genErr) {
                  console.error("text-to-image failed:", genErr);
                  await telegramApi("sendMessage", {
                    chat_id: chatId,
                    text:
                      "Не смог сгенерировать изображение.\n" +
                      "Попробуй другой промпт или модель.\n\n" +
                      `Ошибка: ${formatHfError(genErr)}`
                  });
                }
              }
            }
          }
        }
      }

      // 2) Photo message (for pending /img flow)
      const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;
      if (hasPhoto && isPending(chatId, now)) {
        clearPending(chatId);

        const bestPhoto = message.photo[message.photo.length - 1];
        const fileId = bestPhoto?.file_id;
        if (!fileId) {
          await telegramApi("sendMessage", { chat_id: chatId, text: "Не вижу file_id у фото :(" });
        } else {
          await telegramApi("sendMessage", {
            chat_id: chatId,
            text: "Обрабатываю фото…"
          });

          try {
            const inputBlob = await downloadTelegramPhotoAsBlob(fileId);
            const outBlob = await stylizePhoto(inputBlob);
            const fileName = guessFileNameFromMime(outBlob.type);

            const form = new FormData();
            form.append("chat_id", String(chatId));
            form.append("photo", outBlob, fileName);
            form.append("caption", (process.env.IMG_STYLE_PROMPT || "В мире дикой природы").trim().slice(0, 1024));

            await telegramApiMultipart("sendPhoto", form);
          } catch (err) {
            console.error("photo stylization failed:", err);
            await telegramApi("sendMessage", {
              chat_id: chatId,
              text:
                "Не смог обработать фото.\n" +
                "Попробуй отправить другое фото или поменять модель.\n\n" +
                `Ошибка: ${formatHfError(err)}`
            });
          }
        }
      }
    }

    return sendJson(res, 200, { ok: true });
  } catch (err) {
    // Telegram will retry on non-200; we prefer 200 to avoid retry storms.
    console.error(err);
    return sendJson(res, 200, { ok: false });
  }
};
