const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set");
  process.exit(1);
}

const url = process.argv[2];
if (!url) {
  console.error("Usage: npm run set-webhook -- https://<domain>/api/telegram");
  process.exit(1);
}

const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET;

const resp = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url,
    ...(secretToken ? { secret_token: secretToken } : {})
  })
});

const json = await resp.json().catch(() => null);
if (!resp.ok || !json?.ok) {
  console.error("setWebhook failed:", json ?? resp.status);
  process.exit(1);
}

console.log("Webhook set:", json);

