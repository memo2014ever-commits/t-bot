// يُستدعى مرة واحدة بعد كل deploy لتحديث الـ webhook مع allowed_updates
export default async function handler(req, res) {
  const { BOT_TOKEN, SETUP_SECRET } = process.env;
  if (!BOT_TOKEN) return res.status(500).json({ error: "BOT_TOKEN missing" });
  if (SETUP_SECRET && req.query.secret !== SETUP_SECRET) return res.status(401).json({ error: "unauthorized" });

  const host = req.headers.host;
  const webhookUrl = `https://${host}/api/webhook`;

  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ["message", "callback_query"],
    }),
  });
  const j = await r.json();
  return res.json(j);
}
