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

function isStartCommand(text) {
  if (!text) return false;
  // /start or /start <payload> or /start@botname
  return /^\/start(\s|$|@)/i.test(text.trim());
}

function parseImgCommand(text) {
  if (!text) return null;
  const trimmed = text.trim();
  const match = trimmed.match(/^\/img(?:@[^\s]+)?(?:\s+([\s\S]+))?$/i);
  if (!match) return null;
  return (match[1] ?? "").trim();
}

async function generateImage(prompt) {
  const hfToken = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN;
  if (!hfToken) throw new Error("HF_TOKEN is not set");

  const model = process.env.HF_TEXT_TO_IMAGE_MODEL || "runwayml/stable-diffusion-v1-5";
  const endpointUrl =
    process.env.HF_ENDPOINT_URL ||
    process.env.HF_INFERENCE_ENDPOINT_URL ||
    `https://api-inference.huggingface.co/models/${model}`;

  const { InferenceClient } = await import("@huggingface/inference");
  const client = new InferenceClient(hfToken);

  // Returns a Blob in Node 18+
  return await client.textToImage({
    // Use explicit endpoint to avoid provider-mapping lookups (which may be missing for some models)
    endpointUrl,
    inputs: prompt,
    // Keep it fast for serverless timeouts / free inference
    parameters: { num_inference_steps: 5 },
    // HF Inference API options (helps with cold starts)
    options: { wait_for_model: true, use_cache: true }
  });
}

function guessFileNameFromMime(mimeType) {
  const t = (mimeType || "").toLowerCase();
  if (t.includes("png")) return "image.png";
  if (t.includes("jpeg") || t.includes("jpg")) return "image.jpg";
  if (t.includes("webp")) return "image.webp";
  return "image.bin";
}

function formatHfError(err) {
  const status = err?.httpResponse?.status;
  const requestId = err?.httpResponse?.requestId;
  const body = err?.httpResponse?.body;
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

  return (header + msg + extra).slice(0, 3500);
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
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

    if (message?.chat?.id && typeof message.text === "string") {
      const chatId = message.chat.id;
      const text = message.text;

      if (isStartCommand(text)) {
        await telegramApi("sendMessage", { chat_id: chatId, text: "привет" });
      } else {
        const prompt = parseImgCommand(text);
        if (prompt !== null) {
          if (!prompt) {
            await telegramApi("sendMessage", {
              chat_id: chatId,
              text: "Использование: /img <что нарисовать>"
            });
          } else {
            await telegramApi("sendMessage", {
              chat_id: chatId,
              text: "Генерирую изображение…"
            });

            try {
              const imageBlob = await generateImage(prompt);
              const fileName = guessFileNameFromMime(imageBlob.type);

              const form = new FormData();
              form.append("chat_id", String(chatId));
              form.append("photo", imageBlob, fileName);
              form.append("caption", prompt.slice(0, 1024));

              await telegramApiMultipart("sendPhoto", form);
            } catch (genErr) {
              console.error("image generation failed:", genErr);
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

    return sendJson(res, 200, { ok: true });
  } catch (err) {
    // Telegram will retry on non-200; we prefer 200 to avoid retry storms.
    console.error(err);
    return sendJson(res, 200, { ok: false });
  }
};
