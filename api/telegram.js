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

function getGeminiApiKey() {
  const key =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_AI_STUDIO_API_KEY ||
    process.env.GOOGLE_API_KEY;
  return typeof key === "string" ? key.trim() : "";
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

async function geminiGenerateImage({ prompt, inputImageBlob }) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const model = (process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image").trim();

  const parts = [];
  if (prompt) parts.push({ text: prompt });
  if (inputImageBlob) {
    const base64 = await blobToBase64(inputImageBlob);
    parts.push({
      inlineData: {
        mimeType: inputImageBlob.type || "image/jpeg",
        data: base64
      }
    });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }]
    })
  });

  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    const details = json ? JSON.stringify(json) : String(resp.status);
    const err = new Error(`Gemini API error: ${details}`);
    err.httpStatus = resp.status;
    err.httpBody = json ?? details;
    throw err;
  }

  const candidate = json?.candidates?.[0];
  const outParts = candidate?.content?.parts;
  if (!Array.isArray(outParts)) throw new Error("Gemini API: missing candidates[0].content.parts");

  const imgPart = outParts.find((p) => p?.inlineData?.data);
  if (!imgPart) {
    const textPart = outParts.find((p) => typeof p?.text === "string")?.text;
    throw new Error(`Gemini API: no image returned${textPart ? `: ${textPart}` : ""}`);
  }

  const mimeType = imgPart.inlineData.mimeType || "image/png";
  const bytes = Buffer.from(imgPart.inlineData.data, "base64");
  return new Blob([bytes], { type: mimeType });
}

async function generateImage(prompt) {
  if (getGeminiApiKey()) {
    return await geminiGenerateImage({ prompt });
  }

  let hfToken = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN;
  if (!hfToken) throw new Error("HF_TOKEN is not set");
  hfToken = hfToken.trim();
  if (/^bearer\s+/i.test(hfToken)) hfToken = hfToken.replace(/^bearer\s+/i, "").trim();
  if (!hfToken.startsWith("hf_")) {
    throw new Error(
      "HF_TOKEN must be a Hugging Face Access Token (usually starts with 'hf_'). Create one in Hugging Face Settings → Access Tokens."
    );
  }

  // Pick a model that is actually served by HF Inference (catalog changes over time).
  // Defaulting to a commonly-available text-to-image model on hf-inference.
  const model =
    process.env.HF_TEXT_TO_IMAGE_MODEL || "black-forest-labs/FLUX.1-schnell";
  const endpointUrl =
    process.env.HF_ENDPOINT_URL ||
    process.env.HF_INFERENCE_ENDPOINT_URL ||
    `https://router.huggingface.co/hf-inference/models/${model}`;

  const { InferenceClient } = await import("@huggingface/inference");
  const client = new InferenceClient(hfToken);

  const isStableDiffusionFamily =
    model.includes("stable-diffusion") ||
    model.includes("sdxl") ||
    model.startsWith("stabilityai/");

  // Returns a Blob in Node 18+
  return await client.textToImage({
    // Use explicit endpoint to avoid provider-mapping lookups (which may be missing for some models)
    endpointUrl,
    inputs: prompt,
    // Keep it fast for serverless timeouts / free inference (only for SD-like models)
    ...(isStableDiffusionFamily ? { parameters: { num_inference_steps: 5 } } : {}),
    // HF Inference API options (helps with cold starts)
    options: { wait_for_model: true, use_cache: true }
  });
}

async function stylizePhoto(inputImageBlob) {
  if (getGeminiApiKey()) {
    const stylePrompt = (process.env.IMG_STYLE_PROMPT || "В мире дикой природы").trim();
    const prompt =
      "Отредактируй изображение в стилистике: " +
      stylePrompt +
      ". Сохрани композицию, но сделай общий стиль соответствующим.";
    return await geminiGenerateImage({ prompt, inputImageBlob });
  }

  let hfToken = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN;
  if (!hfToken) throw new Error("HF_TOKEN is not set");
  hfToken = hfToken.trim();
  if (/^bearer\s+/i.test(hfToken)) hfToken = hfToken.replace(/^bearer\s+/i, "").trim();
  if (!hfToken.startsWith("hf_")) {
    throw new Error(
      "HF_TOKEN must be a Hugging Face Access Token (usually starts with 'hf_'). Create one in Hugging Face Settings → Access Tokens."
    );
  }

  const stylePrompt = (process.env.IMG_STYLE_PROMPT || "В мире дикой природы").trim();
  // This model is mapped to multiple Inference Providers (fal-ai / replicate / wavespeed) via HF router.
  // It supports image-to-image edits driven by a text prompt.
  const model =
    process.env.HF_IMAGE_TO_IMAGE_MODEL || "black-forest-labs/FLUX.1-Kontext-dev";

  const { InferenceClient } = await import("@huggingface/inference");
  const client = new InferenceClient(hfToken);

  const providersCsv = (process.env.HF_IMAGE_PROVIDERS || "").trim();
  const providers = providersCsv
    ? providersCsv.split(",").map((p) => p.trim()).filter(Boolean)
    : ["wavespeed", "replicate", "fal-ai"];

  let lastErr;
  for (const provider of providers) {
    try {
      return await client.imageToImage({
        provider,
        model,
        inputs: inputImageBlob,
        parameters: {
          prompt: stylePrompt,
          // keep it fast for serverless; providers may ignore unsupported params
          num_inference_steps: 5
        },
        options: { wait_for_model: true, use_cache: true }
      });
    } catch (err) {
      lastErr = err;
      const status = err?.httpResponse?.status;
      // 402 = provider requires credits; try next provider if available
      if (status === 402) continue;
      throw err;
    }
  }
  throw lastErr ?? new Error("All image providers failed");
}

function guessFileNameFromMime(mimeType) {
  const t = (mimeType || "").toLowerCase();
  if (t.includes("png")) return "image.png";
  if (t.includes("jpeg") || t.includes("jpg")) return "image.jpg";
  if (t.includes("webp")) return "image.webp";
  return "image.bin";
}

function formatHfError(err) {
  const status = err?.httpResponse?.status ?? err?.httpStatus;
  const requestId = err?.httpResponse?.requestId;
  const body = err?.httpResponse?.body ?? err?.httpBody;
  const url = err?.httpRequest?.url;

  const parts = [];
  if (typeof status === "number") parts.push(`HTTP ${status}`);
  if (typeof requestId === "string" && requestId) parts.push(`requestId=${requestId}`);
  if (typeof url === "string" && url) parts.push(url);

  let bodyText = "";
  if (typeof body === "string") bodyText = body;
  else if (body && typeof body === "object") {
    const candidate =
      typeof body.error === "string"
        ? body.error
        : typeof body.message === "string"
          ? body.message
          : typeof body.detail === "string"
            ? body.detail
            : "";
    bodyText = candidate || JSON.stringify(body);
  }

  const msg = typeof err?.message === "string" ? err.message : String(err);
  const extra = bodyText ? `\n${bodyText}` : "";
  const header = parts.length ? `${parts.join(" | ")}\n` : "";

  const hint =
    status === 401
      ? "\n\nПодсказка: проверь, что `HF_TOKEN` — это Hugging Face Access Token вида `hf_...` (Settings → Access Tokens) и что в значении нет лишнего `Bearer ` / пробелов."
      : status === 402
        ? "\n\nПодсказка: это платный inference-провайдер. Для работы нужно пополнить Hugging Face credits (Billing) или выбрать/подключить другого провайдера."
      : "";

  return (header + msg + extra + hint).slice(0, 3500);
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
