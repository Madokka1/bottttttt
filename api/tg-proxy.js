const crypto = require("crypto");

function send(res, statusCode, body, headers = {}) {
  res.statusCode = statusCode;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(body);
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function base64Url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function sign(secret, fileId, exp) {
  const mac = crypto.createHmac("sha256", secret).update(`${fileId}.${exp}`).digest();
  return base64Url(mac);
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

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") {
      return send(res, 405, "Method not allowed", { "content-type": "text/plain; charset=utf-8" });
    }

    const url = new URL(req.url, "http://localhost");
    const fileId = url.searchParams.get("file_id") || "";
    const expRaw = url.searchParams.get("exp") || "";
    const sig = url.searchParams.get("sig") || "";

    const secret = (process.env.TG_PROXY_SECRET || "").trim();
    if (!secret) {
      return send(res, 500, "TG_PROXY_SECRET is not set", { "content-type": "text/plain; charset=utf-8" });
    }

    const exp = Number(expRaw);
    const now = Math.floor(Date.now() / 1000);
    if (!fileId || !Number.isFinite(exp) || exp <= now) {
      return send(res, 401, "Unauthorized", { "content-type": "text/plain; charset=utf-8" });
    }

    const expectedSig = sign(secret, fileId, expRaw);
    if (!sig || !timingSafeEqual(sig, expectedSig)) {
      return send(res, 401, "Unauthorized", { "content-type": "text/plain; charset=utf-8" });
    }

    const file = await telegramApi("getFile", { file_id: fileId });
    const filePath = file?.file_path;
    if (!filePath) {
      return send(res, 404, "Not found", { "content-type": "text/plain; charset=utf-8" });
    }

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const tgUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const resp = await fetch(tgUrl);
    if (!resp.ok) {
      return send(res, 502, "Bad gateway", { "content-type": "text/plain; charset=utf-8" });
    }

    const contentType = resp.headers.get("content-type") || "application/octet-stream";
    const bytes = Buffer.from(await resp.arrayBuffer());
    return send(res, 200, bytes, { "content-type": contentType, "cache-control": "public, max-age=60" });
  } catch (err) {
    console.error(err);
    return send(res, 500, "Internal error", { "content-type": "text/plain; charset=utf-8" });
  }
};

