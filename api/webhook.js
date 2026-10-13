// بوت تلجرام: قايمة + رجوع + رابط + زرار سؤال + تسجيل الإحصائيات بعد الرد
import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import { trackVisitor, trackPress, pushQuestion } from "./stats.js";

const CONTENT_URL = process.env.CONTENT_URL;
const bot = new Bot(process.env.BOT_TOKEN);
const ASK_PROMPT = "اكتب سؤالك هنا";

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

// "0.2" = الزرار رقم 0 جواه الزرار رقم 2. الجذر = ""
function getNode(root, path) {
  let node = root;
  if (path === "") return node;
  for (const i of path.split(".").map(Number)) node = node.items[i];
  return node;
}

// يحوّل [كلمة](https://...) لكلمة قابلة للضغط، والباقي يتعرض زي ما هو
function toHtml(text = "") {
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc(text).replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, (_, label, url) =>
    `<a href="${url}">${label}</a>`);
}

function render(node, path) {
  const kb = new InlineKeyboard();
  (node.items || []).forEach((item, i) => {
    if (item.action === "ask") kb.text(item.label, "ask").row();          // زرار سؤال
    else if (item.url) kb.url(item.label, item.url).row();                 // زرار رابط
    else kb.text(item.label, `n:${path ? path + "." : ""}${i}`).row();     // قايمة فرعية
  });
  if (path !== "") {
    const parent = path.includes(".") ? path.slice(0, path.lastIndexOf(".")) : "";
    kb.text("🔙 رجوع", `b:${parent}`);   // b: = رجوع (ما بيتحسبش كضغطة)
  }
  return { text: node.text, markup: kb };
}

const HTML_OPTS = (markup) => ({
  parse_mode: "HTML",
  reply_markup: markup,
  link_preview_options: { is_disabled: true },
});

bot.command("start", async (ctx) => {
  const { text, markup } = render(await getContent(), "");
  await ctx.reply(toHtml(text), HTML_OPTS(markup));
  try { await trackVisitor(ctx.chat.id, ctx.match || "direct"); } catch {}
});

async function showNode(ctx, path, track) {
  try {
    const node = getNode(await getContent(), path);
    const { text, markup } = render(node, path);
    await ctx.answerCallbackQuery();
    await ctx.reply(toHtml(text), HTML_OPTS(markup));
    if (track) { try { await trackPress(path, node.label); } catch {} }
  } catch {
    await ctx.answerCallbackQuery({ text: "المحتوى اتغير، ابعت /start", show_alert: true });
  }
}

bot.callbackQuery(/^n:(.*)$/, (ctx) => showNode(ctx, ctx.match[1], true));
bot.callbackQuery(/^b:(.*)$/, (ctx) => showNode(ctx, ctx.match[1], false));

// زرار "ابعت سؤالك": بيفتح خانة كتابة للعميل
bot.callbackQuery("ask", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(ASK_PROMPT + " 👇", {
    reply_markup: { force_reply: true, input_field_placeholder: "اكتب سؤالك..." },
  });
  try { await trackPress("ask", "💬 ابعت سؤالك"); } catch {}
});

// الرد على الرسايل النصية: لو رد على خانة السؤال، يتسجل كسؤال
bot.on("message:text", async (ctx) => {
  const r = ctx.message.reply_to_message;
  if (r && r.from?.is_bot && (r.text || "").startsWith(ASK_PROMPT)) {
    try { await pushQuestion(ctx.message.text); } catch {}
    return ctx.reply("استلمنا سؤالك، شكراً لتواصلك 🌷");
  }
  return ctx.reply("اختار من الأزرار تحت 👇");
});

export default webhookCallback(bot, "https");
