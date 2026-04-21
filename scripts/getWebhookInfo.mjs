const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set");
  process.exit(1);
}

const resp = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, { method: "GET" });
const json = await resp.json().catch(() => null);
if (!resp.ok || !json?.ok) {
  console.error("getWebhookInfo failed:", json ?? resp.status);
  process.exit(1);
}

console.log(JSON.stringify(json.result, null, 2));

