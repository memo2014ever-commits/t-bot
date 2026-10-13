// بوت تلجرام: قايمة + رجوع + روابط + زرار سؤال + بحث بالكلمات + تحويل الطبي للخط الساخن
import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import {
  trackVisitor, trackPress, pushQuestion, questionAllowed, questionsLeft, MAX_QUESTIONS_COUNT,
} from "./stats.js";

const CONTENT_URL = process.env.CONTENT_URL;
const bot = new Bot(process.env.BOT_TOKEN);

// الرسايل الافتراضية (تتغير من ⚙️ رسايل النظام في اللوحة)
const DEFAULT_PROMPT = "اكتب سؤالك هنا 👇";
const DEFAULT_THANKS = "استلمنا سؤالك، شكراً لتواصلك 🌷";
const DEFAULT_FALLBACK = "اختار من الأزرار تحت 👇";
const DEFAULT_DYM = "تقصد؟ اختار من دول 👇";
const DEFAULT_MEDICAL = "السؤال ده محتاج متابعة طبية، ومش هقدر أرد عليه هنا.\nللمساعدة اتصل بالخط الساخن 19806 📞";
const DEFAULT_LIMIT = "استنفدت عدد الأسئلة المسموحة ({max}) خلال 24 ساعة 🙏\nتقدر تسأل تاني بعد 24 ساعة من أول سؤال.";
const DEFAULT_LEFT = "(باقي لك {left} أسئلة خلال 24 ساعة)";
const DEFAULT_MED_WORDS = ["علاج", "دوا", "دواء", "ادويه", "اعراض", "الم", "وجع", "مرض", "جرعه", "تشخيص", "حساسيه", "حراره"];

const fill = (t, vars) => Object.entries(vars).reduce((a, [k, v]) => a.split("{" + k + "}").join(String(v)), t);

// تنظيف النص للمقارنة: بدون تشكيل، والحروف المتشابهة واحدة
function norm(t = "") {
  return String(t).toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, "")
    .replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/[^\u0600-\u06FFa-z0-9\s]/g, " ")
    .replace(/\s+/g, " ").trim();
}
const padded = (t) => " " + norm(t) + " ";

function hasMedical(text, custom) {
  const list = Array.isArray(custom) && custom.length ? custom : DEFAULT_MED_WORDS;
  const t = padded(text);
  return list.some((w) => { const k = norm(w); return k && t.includes(" " + k + " "); });
}

// يمشي على كل الشجرة ويرجع المسار مع كل عنصر (نفس طريقة المسارات في الزراير)
function walk(node, path = "", out = []) {
  out.push({ path, node });
  (node.items || []).forEach((c, i) => walk(c, (path ? path + "." : "") + i, out));
  return out;
}

// يدور على الزراير بكلماتها، ويرجع أعلى تطابق بس
function searchNodes(content, text) {
  if (norm(text).length < 2) return [];
  const t = padded(text);
  const hits = [];
  for (const { path, node } of walk(content)) {
    if (path === "" || node.action === "ask") continue;
    if (!node.text && !node.url && !(node.items || []).length) continue;
    // نشيل التكرار: لو الكلمة في الاسم وفي الاستدعاء، تتحسب مرة واحدة بس
    const kws = [...new Set([node.label, ...(Array.isArray(node.keywords) ? node.keywords : [])]
      .map(norm).filter((k) => k.length >= 2))];
    const score = kws.filter((k) => t.includes(" " + k + " ")).length;
    if (score > 0) hits.push({ path, node, score });
  }
  // أي تطابق مع أكتر من زرار = سؤال "تقصد؟"، الترتيب بالأعلى تطابق بس
  return hits.sort((a, b) => b.score - a.score);
}

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

// فلتر السؤال: كلمة من قايمة كلمات السؤال (من اللوحة أو الافتراضية)
const QUESTION_WORDS = [
  "ازاي", "إزاي", "امتى", "إمتى", "فين", "ايه", "إيه", "اي", "ايوه", "هل", "كام", "كم",
  "ممكن", "عايز", "عاوز", "عايزة", "عاوزه", "محتاج", "محتاجة", "لو سمحت", "مين", "ليه", "علشان", "عشان",
  "عنوان", "موعد", "مواعيد", "سعر", "تكلفة", "فيه", "فيها", "متاح", "متاحة", "بيفتح", "بيقفل", "بيشتغل",
  "ينفع", "لازم", "المستندات", "مستندات", "أعرف", "اعرف", "قولي", "ابعتلي", "احجز", "أحجز",
  "اقرب", "أقرب", "لجنة", "لجان", "الكشف", "كشف", "نتيجة", "طلب", "تأجيل", "الغاء", "إلغاء", "تعديل",
];
function looksLikeQuestion(text = "", words = QUESTION_WORDS) {
  if (norm(text).length < 4) return false;
  const t = padded(text);
  return words.some((w) => t.includes(" " + norm(w) + " "));
}

function render(node, path) {
  const kb = new InlineKeyboard();
  (node.items || []).forEach((item, i) => {
    if (item.action === "ask") kb.text(item.label, `ask:${path ? path + "." : ""}${i}`).row();
    else if (item.url) kb.url(item.label, item.url).row();
    else kb.text(item.label, `n:${path ? path + "." : ""}${i}`).row();
  });
  if (path !== "") {
    const parent = path.includes(".") ? path.slice(0, path.lastIndexOf(".")) : "";
    kb.text("🔙 رجوع", `b:${parent}`);
  }
  return { text: node.text || node.label || "—", markup: kb };
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

// زرار "ابعت سؤالك"
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
    await ctx.reply(content.messages?.askPrompt || DEFAULT_PROMPT, {
      reply_markup: { force_reply: true, input_field_placeholder: "اكتب سؤالك..." },
    });
    try { await trackPress(path, node.label); } catch {}
  } catch {
    await ctx.answerCallbackQuery({ text: "المحتوى اتغير، ابعت /start", show_alert: true });
  }
});

// يعرض إجابة زرار واحد (زي ما لو العميل داس عليه)
async function showHit(ctx, hit) {
  try { await trackPress(hit.path, hit.node.label); } catch {}
  if (hit.node.url) {
    const kb = new InlineKeyboard().url(hit.node.label, hit.node.url);
    return ctx.reply(toHtml(hit.node.text || hit.node.label), HTML_OPTS(kb));
  }
  const { text, markup } = render(hit.node, hit.path);
  return ctx.reply(toHtml(text), HTML_OPTS(markup));
}

// الرسايل النصية: طبي؟ ← رد على خانة السؤال؟ ← بحث بالكلمات ← رد عام
bot.on("message:text", async (ctx) => {
  const content = await getContent().catch(() => ({}));
  const m = content.messages || {};
  const text = ctx.message.text || "";
  const root = render(content, "").markup;

  // 1) السؤال الطبي: يتحوّل للخط الساخن
  if (hasMedical(text, content.medicalKeywords)) {
    return ctx.reply(toHtml(m.medical || DEFAULT_MEDICAL), HTML_OPTS(root));
  }

  // 2) رد على خانة السؤال
  const r = ctx.message.reply_to_message;
  const rText = (r && r.text) || "";
  const prompt = m.askPrompt || DEFAULT_PROMPT;
  const isAskPrompt = rText === prompt || rText.startsWith("اكتب سؤالك") || rText.startsWith("مش واضح إنه سؤال");
  if (r && r.from?.is_bot && isAskPrompt) {
    const customWords = Array.isArray(content.questionWords) && content.questionWords.length
      ? content.questionWords : QUESTION_WORDS;
    if (!looksLikeQuestion(text, customWords)) {
      return ctx.reply("مش واضح إنه سؤال، اكتب سؤالك بشكل واضح، مثلاً: ممكن أعرف عنوان لجنة القاهرة؟", {
        reply_markup: { force_reply: true, input_field_placeholder: "اكتب سؤالك..." },
      });
    }
    let allowed = true;
    try { allowed = await questionAllowed(ctx.chat.id); } catch {}
    if (!allowed) return ctx.reply(fill(m.limitReached || DEFAULT_LIMIT, { max: MAX_QUESTIONS_COUNT }), HTML_OPTS(root));
    try { await pushQuestion(text); } catch {}
    const left = await questionsLeft(ctx.chat.id).catch(() => 0);
    const tail = left > 0 ? "\n" + fill(m.remaining || DEFAULT_LEFT, { left }) : "";
    return ctx.reply(toHtml((m.askThanks || DEFAULT_THANKS) + tail), HTML_OPTS(root));
  }

  // 3) بحث بالكلمات في الزراير
  const hits = searchNodes(content, text);
  if (hits.length === 1) return showHit(ctx, hits[0]);
  if (hits.length > 1) {
    const kb = new InlineKeyboard();
    hits.slice(0, 4).forEach((h) => {
      if (h.node.url) kb.url(h.node.label, h.node.url).row();
      else kb.text(h.node.label, `n:${h.path}`).row();
    });
    return ctx.reply(toHtml(m.didYouMean || DEFAULT_DYM), HTML_OPTS(kb));
  }

  // 4) مفيش تطابق: رد عام مع القايمة
  return ctx.reply(toHtml(m.fallback || DEFAULT_FALLBACK), HTML_OPTS(root));
});

export default webhookCallback(bot, "https");
