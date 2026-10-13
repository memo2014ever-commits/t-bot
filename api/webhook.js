// بوت تلجرام: بيعرض القايمة ويتنقل بيها. المحتوى بيتقري من content.json
import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import { trackVisitor, trackPress } from "./stats.js";

const CONTENT_URL = process.env.CONTENT_URL; // رابط raw لملف content.json
const bot = new Bot(process.env.BOT_TOKEN);

// كاش دقيقة عشان ما نحملش GitHub كل ضغطة
let cache = null;
let cacheTime = 0;
async function getContent() {
  if (!cache || Date.now() - cacheTime > 60_000) {
    const res = await fetch(CONTENT_URL + "?t=" + Date.now());
    cache = await res.json();
    cacheTime = Date.now();
  }
  return cache;
}


// يحوّل النص: [كلمة](https://...) لكلمة قابلة للضغط، والباقي يتعرض زي ما هو
function toHtml(text = "") {
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc(text).replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, (_, label, url) =>
    `<a href="${url}">${label}</a>`);
}

// المسار "0.2" يعني: الزرار رقم 0، جواه الزرار رقم 2. الجذر = ""
function getNode(root, path) {
  let node = root;
  if (path === "") return node;
  for (const i of path.split(".").map(Number)) node = node.items[i];
  return node;
}

function render(node, path) {
  const kb = new InlineKeyboard();
  (node.items || []).forEach((item, i) => {
    if (item.url) kb.url(item.label, item.url).row();   // زرار يفتح رابط (مثلاً البوت الأساسي)
    else kb.text(item.label, `n:${path ? path + "." : ""}${i}`).row();
  });
  if (path !== "") {
    const parent = path.includes(".") ? path.slice(0, path.lastIndexOf(".")) : "";
    kb.text("🔙 رجوع", `n:${parent}`);
  }
  return { text: node.text, markup: kb };
}

bot.command("start", async (ctx) => {
  const { text, markup } = render(await getContent(), "");
  await ctx.reply(toHtml(text), { parse_mode: "HTML", reply_markup: markup, link_preview_options: { is_disabled: true } });
  // التسجيل بعد الرد: أي مشكلة في الإحصائيات ما تأثرش على العميل
  try { await trackVisitor(ctx.chat.id, ctx.match || "direct"); } catch {}
});

bot.callbackQuery(/^n:(.*)$/, async (ctx) => {
  const path = ctx.match[1];
  try {
    const node = getNode(await getContent(), path);
    const { text, markup } = render(node, path);
    // نبعت رسالة جديدة (زي أي بوت طبيعي) بدل ما نعدّل القايمة
    await ctx.answerCallbackQuery();
    await ctx.reply(toHtml(text), { parse_mode: "HTML", reply_markup: markup, link_preview_options: { is_disabled: true } });
    // التسجيل بعد الرد
    try { await trackPress(path); } catch {}
  } catch {
    await ctx.answerCallbackQuery({ text: "المحتوى اتغير، ابعت /start", show_alert: true });
  }
});

bot.on("message", (ctx) => ctx.reply("اختار من الأزرار تحت 👇"));

export default webhookCallback(bot, "https");
