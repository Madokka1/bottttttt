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

function getHordeBaseUrls() {
  // AI Horde can be flaky; allow fallbacks.
  // Env:
  // - HORDE_BASE_URLS="https://aihorde.net/api/v2,https://stablehorde.net/api/v2"
  // - or legacy HORDE_BASE_URL
  const raw = (process.env.HORDE_BASE_URLS || process.env.HORDE_BASE_URL || "").trim();
  const list = raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : ["https://aihorde.net/api/v2", "https://stablehorde.net/api/v2"];
  return list.map((u) => u.replace(/\/+$/, ""));
}

function hordeCheckReplyMarkup(jobId) {
  return {
    inline_keyboard: [[{ text: "Проверить", callback_data: `horde_check:${jobId}` }]]
  };
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

function withTimeout(ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return { controller, timeout };
}

function getHordeTimeoutMsForRequest({ path, method }) {
  const defaultTimeout = Number(process.env.HORDE_HTTP_TIMEOUT_MS || 45000);
  const submitTimeout = Number(process.env.HORDE_SUBMIT_HTTP_TIMEOUT_MS || defaultTimeout);
  const checkTimeout = Number(process.env.HORDE_CHECK_HTTP_TIMEOUT_MS || 20000);

  if (path === "/generate/async" && method === "POST") return submitTimeout;
  if (path.startsWith("/generate/check/") || path.startsWith("/generate/status/")) return checkTimeout;
  return defaultTimeout;
}

const HORDE_JOB_TTL_MS = 60 * 60 * 1000;
const hordeJobMetaById = new Map();

function setHordeJobMeta(id, meta) {
  const now = Date.now();
  hordeJobMetaById.set(String(id), { ...meta, createdAt: now });
  for (const [jobId, m] of hordeJobMetaById.entries()) {
    if (!m?.createdAt || now - m.createdAt > HORDE_JOB_TTL_MS) hordeJobMetaById.delete(jobId);
  }
}

function getHordeJobMeta(id) {
  const meta = hordeJobMetaById.get(String(id));
  if (!meta) return null;
  if (!meta.createdAt || Date.now() - meta.createdAt > HORDE_JOB_TTL_MS) {
    hordeJobMetaById.delete(String(id));
    return null;
  }
  return meta;
}

async function hordeFetch(path, init) {
  const headers = {
    ...(init?.headers || {}),
    apikey: getHordeApiKey(),
    "content-type": "application/json"
  };

  const method = (init?.method || "GET").toUpperCase();
  const maxRetries =
    typeof init?.retries === "number"
      ? init.retries
      : method === "GET"
        ? 3
        : 0;

  let lastErr;
  const baseUrls = getHordeBaseUrls();
  for (const baseUrl of baseUrls) {
    const url = `${baseUrl}${path}`;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const timeoutMs = getHordeTimeoutMsForRequest({ path, method });
      const { controller, timeout } = withTimeout(timeoutMs);
      try {
        const resp = await fetch(url, { ...init, headers, signal: controller.signal });
        const json = await resp.json().catch(() => null);
        if (!resp.ok) {
          const details = json ? JSON.stringify(json) : String(resp.status);
          const err = new Error(`AI Horde error: ${details}`);
          err.httpStatus = resp.status;
          err.httpBody = json ?? details;
          err.httpUrl = url;
          lastErr = err;

          const transient = [502, 503, 504].includes(resp.status);
          // Retry on transient errors for GETs
          if (method === "GET" && transient && attempt < maxRetries) {
            await sleep(500 * (attempt + 1));
            continue;
          }
          // On transient errors, try the next base URL
          if (transient) break;

          throw err;
        }
        return json;
      } catch (err) {
        const isAbort = err?.name === "AbortError";
        if (isAbort) {
          const wrapped = new Error("This operation was aborted");
          wrapped.name = "AbortError";
          wrapped.httpStatus = 408;
          wrapped.httpUrl = url;
          wrapped.httpBody = { timeoutMs };
          lastErr = wrapped;
          err = wrapped;
        } else {
          lastErr = err;
        }
        const transient = isAbort || err?.httpStatus === 503 || err?.httpStatus === 504 || err?.httpStatus === 502;
        if (method === "GET" && transient && attempt < maxRetries) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        // If transient, try next base URL
        if (transient) break;
        throw err;
      } finally {
        clearTimeout(timeout);
      }
    }
  }
  throw lastErr;
}

function formatHttpError(err) {
  const status = err?.httpStatus;
  const url = err?.httpUrl;
  const body = err?.httpBody;
  const msg = typeof err?.message === "string" ? err.message : String(err);
  const isAbort = err?.name === "AbortError" || /aborted/i.test(msg);

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
    isAbort
      ? "\n\nПодсказка: запрос к AI Horde превысил таймаут. Увеличь `HORDE_SUBMIT_HTTP_TIMEOUT_MS` (например до 60000) и попробуй снова."
      : status === 429
      ? "\n\nПодсказка: лимит AI Horde исчерпан, попробуй через минуту или используй свой HORDE_API_KEY."
      : status === 503
        ? "\n\nПодсказка: AI Horde сейчас перегружен/недоступен. Попробуй ещё раз позже."
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

async function hordeSubmit({ prompt, sourceImageBlob }) {
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
    body: JSON.stringify(payload),
    retries: 2
  });

  const id = submit?.id;
  if (!id) throw new Error("AI Horde: missing job id");
  return id;
}

async function hordeCheck(id) {
  return await hordeFetch(`/generate/check/${id}`, { method: "GET", retries: 3 });
}

async function hordeGetResultBlob(id) {
  const status = await hordeFetch(`/generate/status/${id}`, { method: "GET", retries: 3 });
  const gen = status?.generations?.[0];
  const b64 = gen?.img;
  if (!b64) throw new Error("AI Horde: generation finished but no image data");
  const bytes = Buffer.from(b64, "base64");
  return new Blob([bytes], { type: "image/webp" });
}

function describeHordeCheck(check) {
  if (!check || typeof check !== "object") return "В очереди…";
  const wait = typeof check.wait_time === "number" ? check.wait_time : null;
  const queue = typeof check.queue_position === "number" ? check.queue_position : null;
  const parts = [];
  if (queue !== null) parts.push(`позиция: ${queue}`);
  if (wait !== null) parts.push(`ожидание: ~${wait}с`);
  return parts.length ? `В очереди (${parts.join(", ")})…` : "В очереди…";
}

async function answerCallbackQuery(id) {
  if (!id) return;
  try {
    await telegramApi("answerCallbackQuery", { callback_query_id: id });
  } catch (err) {
    console.error("answerCallbackQuery failed:", err);
  }
}

async function sendPhotoBlob(chatId, blob, caption) {
  const fileName = guessFileNameFromMime(blob.type);
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", blob, fileName);
  if (caption) form.append("caption", caption.slice(0, 1024));
  await telegramApiMultipart("sendPhoto", form);
}

async function tryDeliverHordeJob({ chatId, jobId, caption }) {
  const check = await hordeCheck(jobId);
  if (check?.done === true) {
    const blob = await hordeGetResultBlob(jobId);
    await sendPhotoBlob(chatId, blob, caption);
    return { delivered: true, check };
  }
  return { delivered: false, check };
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
    const callbackQuery = update?.callback_query;

    if (callbackQuery?.id) {
      await answerCallbackQuery(callbackQuery.id);
      const chatId = callbackQuery?.message?.chat?.id;
      const data = callbackQuery?.data;

      if (chatId && typeof data === "string" && data.startsWith("horde_check:")) {
        const jobId = data.slice("horde_check:".length).trim();
        try {
          const meta = getHordeJobMeta(jobId);
          const caption = meta?.caption || "";
          const result = await tryDeliverHordeJob({ chatId, jobId, caption });
          if (!result.delivered) {
            await telegramApi("sendMessage", {
              chat_id: chatId,
              text: describeHordeCheck(result.check) + "\nНажми «Проверить» ещё раз через пару секунд.",
              reply_markup: hordeCheckReplyMarkup(jobId)
            });
          }
        } catch (err) {
          console.error("horde check failed:", err);
          await telegramApi("sendMessage", {
            chat_id: chatId,
            text: `Ошибка: ${formatHfError(err)}`
          });
        }
      }
    }

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
                  const jobId = await hordeSubmit({ prompt: t2iPrompt });
                  setHordeJobMeta(jobId, { chatId, caption: t2iPrompt });

                  // Always send a "check" button quickly, then optionally deliver if ready.
                  let check = null;
                  try {
                    check = await hordeCheck(jobId);
                  } catch {
                    // ignore; Horde can be flaky
                  }
                  await telegramApi("sendMessage", {
                    chat_id: chatId,
                    text: (check ? describeHordeCheck(check) : "Задача поставлена в очередь…") + "\nНажми «Проверить», когда будет готово.",
                    reply_markup: hordeCheckReplyMarkup(jobId)
                  });

                  for (let i = 0; i < 2; i++) {
                    const result = await tryDeliverHordeJob({ chatId, jobId, caption: t2iPrompt });
                    if (result.delivered) break;
                    await sleep(1500);
                  }
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
            const stylePrompt = (process.env.IMG_STYLE_PROMPT || "В мире дикой природы").trim();
            const prompt =
              "Отредактируй изображение в стилистике: " +
              stylePrompt +
              ". Сохрани композицию, но сделай общий стиль соответствующим.";

            const jobId = await hordeSubmit({ prompt, sourceImageBlob: inputBlob });
            setHordeJobMeta(jobId, { chatId, caption: stylePrompt });

            let check = null;
            try {
              check = await hordeCheck(jobId);
            } catch {
              // ignore; Horde can be flaky
            }
            await telegramApi("sendMessage", {
              chat_id: chatId,
              text: (check ? describeHordeCheck(check) : "Задача поставлена в очередь…") + "\nНажми «Проверить», когда будет готово.",
              reply_markup: hordeCheckReplyMarkup(jobId)
            });

            for (let i = 0; i < 2; i++) {
              const result = await tryDeliverHordeJob({ chatId, jobId, caption: stylePrompt });
              if (result.delivered) break;
              await sleep(1500);
            }
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
