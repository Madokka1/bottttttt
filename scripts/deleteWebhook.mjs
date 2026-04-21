const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set");
  process.exit(1);
}

const resp = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ drop_pending_updates: false })
});

const json = await resp.json().catch(() => null);
if (!resp.ok || !json?.ok) {
  console.error("deleteWebhook failed:", json ?? resp.status);
  process.exit(1);
}

console.log("Webhook deleted:", json);

