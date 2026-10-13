// بوت تلجرام: قايمة + رجوع + رابط + زرار سؤال + تسجيل الإحصائيات بعد الرد
import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import { trackVisitor, trackPress, pushQuestion, questionAllowed, questionsLeft, MAX_QUESTIONS_COUNT } from "./stats.js";

const DEFAULT_LIMIT = "استنفدت عدد الأسئلة المسموحة ({max}) خلال 24 ساعة 🙏\nتقدر تسأل تاني بعد 24 ساعة من أول سؤال.";
const DEFAULT_LEFT = "(باقي لك {left} أسئلة خلال 24 ساعة)";
const fill = (t, vars) => Object.entries(vars).reduce((a, [k, v]) => a.split("{" + k + "}").join(String(v)), t);

const CONTENT_URL = process.env.CONTENT_URL;
const bot = new Bot(process.env.BOT_TOKEN);
const DEFAULT_PROMPT = "اكتب سؤالك هنا 👇";
const DEFAULT_THANKS = "استلمنا سؤالك، شكراً لتواصلك 🌷";
const DEFAULT_FALLBACK = "اختار من الأزرار تحت 👇";

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
    if (item.action === "ask") kb.text(item.label, `ask:${path ? path + "." : ""}${i}`).row(); // زرار سؤال
    else if (item.url) kb.url(item.label, item.url).row();                 // زرار رابط
    else kb.text(item.label, `n:${path ? path + "." : ""}${i}`).row();     // قايمة فرعية
  });
  if (path !== "") {
    const parent = path.includes(".") ? path.slice(0, path.lastIndexOf(".")) : "";
    kb.text("🔙 رجوع", `b:${parent}`);   // b: = رجوع (ما بيتحسبش كضغطة)
  }
  return { text: node.text, markup: kb };
}

// فلتر بسيط: الرسالة لازم تبان سؤال (علامة استفهام أو كلمة سؤال)
const QUESTION_WORDS = [
  "ازاي", "إزاي", "ازّاي", "امتى", "إمتى", "فين", "فينن", "ايه", "إيه", "اي", "ايوه", "هل", "كام", "كم",
  "ممكن", "عايز", "عاوز", "عايزة", "عاوزه", "محتاج", "محتاجة", "لو سمحت", "مين", "ليه", "علشان", "عشان",
  "عنوان", "موعد", "مواعيد", "سعر", "تكلفة", "فيه", "فيها", "متاح", "متاحة", "بيفتح", "بيقفل", "بيشتغل",
  "ينفع", "لازم", "المستندات", "مستندات", "أعرف", "اعرف", "اعرّف", "قولي", "قوللي", "ابعتلي", "احجز", "أحجز",
  "اقرب", "أقرب", "لجنة", "لجان", "الكشف", "كشف", "نتيجة", "طلب", "تأجيل", "الغاء", "إلغاء", "تعديل",
];
function looksLikeQuestion(text = "", words = QUESTION_WORDS) {
  const t = text.trim();
  if (t.length < 4) return false;
  const low = " " + t.toLowerCase().replace(/[.,!؟?]/g, " ") + " ";
  // نطابق الكلمة كاملة (عشان "اهلا" ما تتحسبش سؤال بسبب "هل")
  return words.some((w) => low.includes(" " + w + " "));
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

// زرار "ابعت سؤالك": بيفتح خانة كتابة للعميل، وبيتحسب كضغطة زي أي زرار
bot.callbackQuery(/^ask:(.*)$/, async (ctx) => {
  const path = ctx.match[1];
  try {
    const content = await getContent();
    const node = getNode(content, path);
    await ctx.answerCallbackQuery();
    if ((await questionsLeft(ctx.chat.id)) <= 0) {
      const lm = content.messages?.limitReached || DEFAULT_LIMIT;
      return ctx.reply(fill(lm, { max: MAX_QUESTIONS_COUNT }), HTML_OPTS(render(content, "").markup));
    }
    const left = await questionsLeft(ctx.chat.id);
    await ctx.reply((content.messages?.askPrompt) || DEFAULT_PROMPT, {
      reply_markup: { force_reply: true, input_field_placeholder: "اكتب سؤالك..." },
    });
    try { await trackPress(path, node.label); } catch {}
  } catch {
    await ctx.answerCallbackQuery({ text: "المحتوى اتغير، ابعت /start", show_alert: true });
  }
});

// الرد على الرسايل النصية: لو رد على خانة السؤال، يتسجل كسؤال
bot.on("message:text", async (ctx) => {
  const content = await getContent().catch(() => ({}));
  const m = content.messages || {};
  const prompt = m.askPrompt || DEFAULT_PROMPT;
  const r = ctx.message.reply_to_message;
  const rText = (r && r.text) || "";
  // نقبل الرد على رسالة طلب السؤال، أو على رسالة "مش واضح" (عشان العميل يعيد الكتابة)
  const isAskPrompt = rText === prompt || rText.startsWith("اكتب سؤالك") || rText.startsWith("مش واضح إنه سؤال");
  if (r && r.from?.is_bot && isAskPrompt) {
    const customWords = Array.isArray(content.questionWords) && content.questionWords.length
      ? content.questionWords : QUESTION_WORDS;
    if (!looksLikeQuestion(ctx.message.text, customWords)) {
      // مش سؤال واضح: نطلب منه يكتبه تاني
      return ctx.reply("مش واضح إنه سؤال، اكتب سؤالك بشكل واضح، مثلاً: ممكن أعرف عنوان لجنة القاهرة؟", {
        reply_markup: { force_reply: true, input_field_placeholder: "اكتب سؤالك..." },
      });
    }
    let allowed = true;
    try { allowed = await questionAllowed(ctx.chat.id); } catch {}
    if (!allowed) return ctx.reply(fill(m.limitReached || DEFAULT_LIMIT, { max: MAX_QUESTIONS_COUNT }), HTML_OPTS(render(content, "").markup));
    try { await pushQuestion(ctx.message.text); } catch {}
    const left = await questionsLeft(ctx.chat.id).catch(() => 0);
    const tail = left > 0 ? "\n" + fill(m.remaining || DEFAULT_LEFT, { left }) : "";
    // بعد السؤال نرجّع القايمة الرئيسية عشان العميل يكمل تصفح
    return ctx.reply((m.askThanks || DEFAULT_THANKS) + tail, HTML_OPTS(render(content, "").markup));
  }
  // نرجّع القايمة الرئيسية مع الرد، عشان العميل يلاقي الأزرار تاني
  const { markup } = render(content, "");
  return ctx.reply(toHtml(m.fallback || DEFAULT_FALLBACK), HTML_OPTS(markup));
});

export default webhookCallback(bot, "https");
