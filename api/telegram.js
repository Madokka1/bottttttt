const crypto = require("crypto");

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

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return { controller, timeout };
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
    const err = new Error(`Telegram API error: ${details}`);
    err.httpStatus = resp.status;
    err.httpBody = json ?? details;
    throw err;
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
    const err = new Error(`Telegram API error: ${details}`);
    err.httpStatus = resp.status;
    err.httpBody = json ?? details;
    throw err;
  }
  return json.result;
}

function getPublicBaseUrl(req) {
  const vercelUrl = (process.env.VERCEL_URL || "").trim();
  if (vercelUrl) return `https://${vercelUrl}`;
  const host = req?.headers?.host;
  if (host) return `https://${host}`;
  return (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
}

function getPollinationsBaseUrl() {
  return (process.env.POLLINATIONS_BASE_URL || "https://image.pollinations.ai").replace(/\/+$/, "");
}

function parseCommaList(value) {
  const raw = (value || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function mainMenuReplyMarkup() {
  return {
    keyboard: [[{ text: "Сгенерировать" }, { text: "Партнеры" }]],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

function isStartCommand(text) {
  if (!text) return false;
  return /^\/start(\s|$|@)/i.test(text.trim());
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

// Temporarily disabled (as requested): always allow.
async function checkRequiredSubscriptions(userId) {
  void userId;
  return { ok: true, channels: [] };
}

function partnersText() {
  const channels = parseRequiredChannels();
  if (!channels.length) return "Партнеры пока не настроены.";
  const lines = ["Партнеры:"];
  for (const ch of channels) {
    const link = `https://t.me/${ch.replace(/^@/, "")}`;
    lines.push(`- ${ch} — ${link}`);
  }
  return lines.join("\n");
}

function guessFileNameFromMime(mimeType) {
  const t = (mimeType || "").toLowerCase();
  if (t.includes("png")) return "image.png";
  if (t.includes("jpeg") || t.includes("jpg")) return "image.jpg";
  if (t.includes("webp")) return "image.webp";
  return "image.bin";
}

function formatHttpError(err) {
  const status = err?.httpStatus;
  const url = err?.httpUrl;
  const body = err?.httpBody;
  const msg = typeof err?.message === "string" ? err.message : String(err);

  let bodyText = "";
  if (typeof body === "string") bodyText = body;
  else if (body && typeof body === "object") bodyText = JSON.stringify(body);

  const header = `${typeof status === "number" ? `HTTP ${status}` : ""}${url ? ` | ${url}` : ""}`.trim();
  const extra = bodyText ? `\n${bodyText}` : "";
  return `${header ? header + "\n" : ""}${msg}${extra}`.slice(0, 3500);
}

async function pollinationsFetchImage(url) {
  const { controller, timeout } = withTimeout(Number(process.env.POLLINATIONS_HTTP_TIMEOUT_MS || 45000));
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      const err = new Error("Pollinations request failed");
      err.httpStatus = resp.status;
      err.httpUrl = url.toString();
      err.httpBody = await resp.text().catch(() => "");
      throw err;
    }
    return await resp.blob();
  } finally {
    clearTimeout(timeout);
  }
}

async function generateImage(prompt) {
  const baseUrl = getPollinationsBaseUrl();
  const model = (process.env.POLLINATIONS_TEXT_MODEL || "flux").trim();
  const url = new URL(`${baseUrl}/prompt/${encodeURIComponent(prompt)}`);
  url.searchParams.set("model", model);
  url.searchParams.set("nologo", "true");
  return await pollinationsFetchImage(url);
}

function signProxyUrl({ req, fileId }) {
  const secret = (process.env.TG_PROXY_SECRET || "").trim();
  if (!secret) throw new Error("TG_PROXY_SECRET is not set");

  const exp = Math.floor(Date.now() / 1000) + 5 * 60;
  const sig = crypto.createHmac("sha256", secret).update(`${fileId}.${exp}`).digest("base64url");

  const base = getPublicBaseUrl(req);
  if (!base) throw new Error("PUBLIC_BASE_URL/VERCEL_URL is not set");

  return `${base}/api/tg-proxy?file_id=${encodeURIComponent(fileId)}&exp=${exp}&sig=${encodeURIComponent(sig)}`;
}

async function stylizePhoto({ req, fileId }) {
  const stylePrompt = (process.env.IMG_STYLE_PROMPT || "В мире дикой природы").trim();
  const prompt =
    "Отредактируй изображение в стилистике: " +
    stylePrompt +
    ". Сохрани композицию, но сделай общий стиль соответствующим.";

  const inputUrl = signProxyUrl({ req, fileId });

  const baseUrl = getPollinationsBaseUrl();
  const models =
    parseCommaList(process.env.POLLINATIONS_EDIT_MODELS).length > 0
      ? parseCommaList(process.env.POLLINATIONS_EDIT_MODELS)
      : [(process.env.POLLINATIONS_EDIT_MODEL || "flux").trim()].filter(Boolean);

  let lastErr;
  for (const model of models) {
    const url = new URL(`${baseUrl}/prompt/${encodeURIComponent(prompt)}`);
    url.searchParams.set("model", model);
    url.searchParams.set("image", inputUrl);
    url.searchParams.set("nologo", "true");

    try {
      return await pollinationsFetchImage(url);
    } catch (err) {
      lastErr = err;
      const body = typeof err?.httpBody === "string" ? err.httpBody : "";
      // Some models are gated behind enter.pollinations.ai (paid).
      if (body.includes("only available on enter.pollinations.ai")) continue;
      throw err;
    }
  }
  throw lastErr ?? new Error("Pollinations request failed");
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

      // Text handling
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
        } else if (text.trim() === "Сгенерировать" || parseCommand(text, "img") !== null) {
          if (!userId) {
            await telegramApi("sendMessage", { chat_id: chatId, text: "Не вижу user_id :(" });
          } else {
            const subs = await checkRequiredSubscriptions(userId);
            if (!subs.ok) {
              await telegramApi("sendMessage", { chat_id: chatId, text: partnersText() });
            } else {
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
            }
          }
        } else if (text.trim() === "Партнеры") {
          await telegramApi("sendMessage", {
            chat_id: chatId,
            text: partnersText(),
            reply_markup: mainMenuReplyMarkup()
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
              await telegramApi("sendMessage", { chat_id: chatId, text: "Генерирую изображение…" });
              try {
                const imageBlob = await generateImage(t2iPrompt);
                const fileName = guessFileNameFromMime(imageBlob.type);
                const form = new FormData();
                form.append("chat_id", String(chatId));
                form.append("photo", imageBlob, fileName);
                form.append("caption", t2iPrompt.slice(0, 1024));
                await telegramApiMultipart("sendPhoto", form);
              } catch (err) {
                console.error("text-to-image failed:", err);
                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text:
                    "Не смог сгенерировать изображение.\n\n" +
                    `Ошибка: ${formatHttpError(err)}`
                });
              }
            }
          }
        }
      }

      // Photo handling for pending flow
      const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;
      if (hasPhoto && isPending(chatId, now)) {
        clearPending(chatId);

        const bestPhoto = message.photo[message.photo.length - 1];
        const fileId = bestPhoto?.file_id;
        if (!fileId) {
          await telegramApi("sendMessage", { chat_id: chatId, text: "Не вижу file_id у фото :(" });
        } else {
          await telegramApi("sendMessage", { chat_id: chatId, text: "Обрабатываю фото…" });
          try {
            const outBlob = await stylizePhoto({ req, fileId });
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
                "Не смог обработать фото.\n\n" +
                `Ошибка: ${formatHttpError(err)}`
            });
          }
        }
      }
    }

    return sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error(err);
    return sendJson(res, 200, { ok: false });
  }
};
