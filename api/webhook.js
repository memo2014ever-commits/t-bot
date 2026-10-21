// بوت تلجرام: قايمة + رجوع + روابط + زرار سؤال + بحث بالكلمات + تحويل الطبي للخط الساخن
import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import {
  trackVisitor, trackActive, trackPress, pushQuestion, questionAllowed, questionsLeft, MAX_QUESTIONS_COUNT, trackUnmatched, questionForReply, addFollowup, closeExpiredQuestions, maybeExpireQuestions, setPending, takePending,
} from "./stats.js";

const CONTENT_URL = process.env.CONTENT_URL;
const bot = new Bot(process.env.BOT_TOKEN);

const DEFAULT_CLOSED_AUTO = "🔒 تم إغلاق سؤالك تلقائيًا لعدم وجود متابعة خلال 24 ساعة.\n\nإذا كان لديك استفسار جديد، استخدم زر «ابعت سؤالك» 👇";
async function notifyExpired(items, message = DEFAULT_CLOSED_AUTO) {
  await Promise.all((items || []).map((x) => bot.api.sendMessage(x.chatId, message).catch(() => {})));
}

// الرسايل الافتراضية (تتغير من ⚙️ رسايل النظام في اللوحة)
const DEFAULT_PROMPT = "اكتب سؤالك هنا 👇";
const DEFAULT_THANKS = "استلمنا سؤالك، شكراً لتواصلك 🌷";
const DEFAULT_FALLBACK = "اختار من الأزرار تحت 👇";
const DEFAULT_DYM = "تقصد؟ اختار من دول 👇";
const DEFAULT_MEDICAL = "السؤال ده محتاج متابعة طبية، ومش هقدر أرد عليه هنا.\nللمساعدة اتصل بالخط الساخن 19806 📞";
const DEFAULT_LIMIT = "استنفدت عدد الأسئلة المسموحة ({max}) خلال 24 ساعة 🙏\nتقدر تسأل تاني بعد 24 ساعة من أول سؤال.";
const DEFAULT_LEFT = "(باقي لك {left} أسئلة خلال 24 ساعة)";
const DEFAULT_FOLLOWUP_RECEIVED = "تم استلام المتابعة على نفس السؤال ✅\nسيتم الرد عليك هنا.";
const DEFAULT_FOLLOWUP_LIMIT = "تم الوصول للحد الأقصى للمتابعات على هذا السؤال. لو عندك استفسار جديد، استخدم زر «ابعت سؤالك» 👇";
const DEFAULT_INQUIRY = "للاستعلام عن موعدك أو حجزك، ادخل على بوت الحجز مباشرة 👇";
const DEFAULT_INQUIRY_WORDS = ["استعلم", "استعلام", "موعدي", "حجزي", "متابعه", "حاله الطلب", "رقم الطلب"];
const DEFAULT_MED_WORDS = ["علاج", "دوا", "دواء", "ادويه", "اعراض", "الم", "وجع", "مرض", "جرعه", "تشخيص", "حساسيه", "حراره"];

const fill = (t, vars) => Object.entries(vars).reduce((a, [k, v]) => a.split("{" + k + "}").join(String(v)), t);

// تنظيف النص للمقارنة: بدون تشكيل، والحروف المتشابهة واحدة
function norm(t = "") {
  return String(t).toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, "")
    .replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/[،؛؟,.!:()\[\]"«»-]/g, " ")
    .replace(/[^\u0600-\u06FFa-z0-9\s]/g, " ")
    .replace(/\s+/g, " ").trim();
}
const padded = (t) => " " + norm(t) + " ";

function hasInquiry(text, custom) {
  const list = Array.isArray(custom) && custom.length ? custom : DEFAULT_INQUIRY_WORDS;
  const t = padded(text);
  return list.some((w) => { const k = norm(w); return k && t.includes(" " + k + " "); });
}

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

// كلمات عامة ما ينفعش تحدد زرار (زي فين، ازاي، لجنة)
const COMMON = new Set([
  "ازاي", "امتى", "فين", "ايه", "هل", "كام", "ممكن", "عايز", "عاوز", "محتاج", "عنوان", "موعد", "مواعيد",
  "سعر", "لجنة", "لجان", "مكان", "موقع", "اعرف", "ليه", "مين", "لو", "سمحت", "علشان", "عشان",
].map(norm));

function distinctTokens(text) {
  return [...new Set(norm(text).split(" ").filter((t) => t.length >= 3 && !COMMON.has(t)))];
}

// يدور في: اسم الزرار + كلمات الاستدعاء (وزنهم 2)، ونص الرسالة (وزنه 1)
// بيرجع الأدق أولاً، وحد أقصى 5
function searchNodes(content, text) {
  if (norm(text).length < 2) return [];
  const t = padded(text);
  const qt = distinctTokens(text);
  const hits = [];
  for (const { path, node } of walk(content)) {
    if (path === "" || node.action === "ask") continue;
    if (!node.text && !node.url && !(node.items || []).length) continue;
    const kws = [...new Set([node.label, ...(Array.isArray(node.keywords) ? node.keywords : [])]
      .map(norm).filter((k) => k.length >= 2))];
    const nameScore = kws.filter((k) => t.includes(" " + k + " ")).length * 2;
    // الكلمة المفردة جوه أي عبارة (زي "الاوراق" جوه "الأوراق المطلوبة")
    const kwTokens = new Set(kws.flatMap((k) => k.split(" ")).filter((x) => x.length >= 3 && !COMMON.has(x)));
    const tokenScore = qt.filter((tok) => kwTokens.has(tok)).length;

    let snippet = "";
    let textScore = 0;
    const lines = String(node.text || "").split("\n");
    for (const tok of qt) {
      const line = lines.find((l) => norm(l).split(" ").includes(tok));
      if (line) { textScore++; if (!snippet) snippet = line.trim(); }
    }
    const score = nameScore + tokenScore + textScore;
    if (score > 0) {
      hits.push({ path, node, score, matchedIn: nameScore + tokenScore > 0 ? "name" : "text", snippet });
    }
  }
  return hits.sort((x, y) => y.score - x.score).slice(0, 5);
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

// اسم الزرار الأب لأي مسار (عشان "تقصد؟" توضح المكان)
function parentLabelOf(content, path) {
  if (!path.includes(".")) return "";
  const parent = getNode(content, path.slice(0, path.lastIndexOf(".")));
  return parent?.label || "";
}

// يحوّل نص الاختيار: اسم البند + المكان بين قوسين
function choiceLine(content, hit) {
  const where = parentLabelOf(content, hit.path);
  return where ? `• ${hit.node.label} (${where})` : `• ${hit.node.label}`;
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
    kb.text("🔙 رجوع", `b:${parent}`).row();
    kb.text("🏠 القايمة الرئيسية", "home");   // يرجّع لأول قايمة في البوت
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
  try { await trackVisitor(ctx.chat.id, ctx.match || ""); } catch {}
});

async function showNode(ctx, path, track) {
  try {
    try { await trackActive(ctx.chat.id); } catch {}
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
bot.callbackQuery("home", (ctx) => showNode(ctx, "", false));


const SHORT_REPLIES = new Set([
  "شكرا", "شكراً", "تمام", "تمام شكرا", "اهلا", "أهلا", "السلام عليكم", "وعليكم السلام", "الو", "الوو", "ok", "اوك", "ماشي",
].map((x) => norm(x)));

// الرد على خانة السؤال: قصير؟ ← بحث ← (إجابة واحدة: يرد) (أكتر: تقصد + بديل) (مفيش: يسجل)
async function handleAskReply(ctx, text, content, m, root) {
  const cleaned = norm(text);
  if (cleaned.length < 3 || SHORT_REPLIES.has(cleaned)) {
    return ctx.reply("اكتب سؤالك بشكل أوضح 👇", {
      reply_markup: { force_reply: true, input_field_placeholder: "اكتب سؤالك..." },
    });
  }
  const hits = searchNodes(content, text);
  if (hits.length === 1) return showHit(ctx, hits[0]);
  if (hits.length > 1) {
    try { await setPending(ctx.chat.id, text); } catch {}
    return showChoices(ctx, hits, content, m, true);
  }
  return saveAndThank(ctx, text, m, root);
}

// تسجيل السؤال + الشكر + المتبقي من الحد
async function saveAndThank(ctx, text, m, root) {
  let allowed = true;
  try { allowed = await questionAllowed(ctx.chat.id); } catch {}
  if (!allowed) return ctx.reply(fill(m.limitReached || DEFAULT_LIMIT, { max: MAX_QUESTIONS_COUNT }), HTML_OPTS(root));
  const customerName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || (ctx.from?.username ? `@${ctx.from.username}` : "");
  try { await pushQuestion(text, ctx.chat.id, customerName); } catch {}
  const left = await questionsLeft(ctx.chat.id).catch(() => 0);
  const tail = left > 0 ? "\n" + fill(m.remaining || DEFAULT_LEFT, { left }) : "";
  return ctx.reply(toHtml((m.askThanks || DEFAULT_THANKS) + tail), HTML_OPTS(root));
}

// اختيارات "تقصد؟" (وممكن زرار بديل لو ده مش قصده)
async function showChoices(ctx, hits, content, m, withSendAnyway) {
  const top = hits.slice(0, 4);
  const kb = new InlineKeyboard();
  top.forEach((h) => {
    if (h.node.url) kb.url(h.node.label, h.node.url).row();
    else kb.text(h.node.label, `n:${h.path}`).row();
  });
  if (withSendAnyway) kb.text("📝 لا، ده مش قصدي، ابعت سؤالي", "pq").row();
  const lines = top.map((h) => choiceLine(content, h)).join("\n");
  return ctx.reply(toHtml((m.didYouMean || DEFAULT_DYM) + "\n\n" + lines), HTML_OPTS(kb));
}

// العميل قال "ده مش قصدي": نسجل السؤال المعلّق
bot.callbackQuery("pq", async (ctx) => {
  await ctx.answerCallbackQuery();
  let text = null;
  try { text = await takePending(ctx.chat.id); } catch {}
  const content = await getContent().catch(() => ({}));
  const m = content.messages || {};
  const root = render(content, "").markup;
  if (!text) return ctx.reply("انتهت المهلة، اكتب سؤالك تاني 👇", {
    reply_markup: { force_reply: true, input_field_placeholder: "اكتب سؤالك..." },
  });
  return saveAndThank(ctx, text, m, root);
});

// زرار "ابعت سؤالك"
bot.callbackQuery(/^ask:(.*)$/, async (ctx) => {
  const path = ctx.match[1];
  try {
    try { await trackActive(ctx.chat.id); } catch {}
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
  // لو المطابقة في النص: نعرض السطر اللي فيه المعلومة بس، ومعاه اسم المكان
  if (hit.matchedIn === "text" && hit.snippet) {
    return ctx.reply(toHtml(`📍 ${hit.node.label}\n${hit.snippet}`), HTML_OPTS(markup));
  }
  return ctx.reply(toHtml(text), HTML_OPTS(markup));
}

// الرسايل النصية: طبي؟ ← رد على خانة السؤال؟ ← بحث بالكلمات ← رد عام
bot.on("message:text", async (ctx) => {
  try { await trackActive(ctx.chat.id); } catch {}
  const content = await getContent().catch(() => ({}));
  const m = content.messages || {};
  try { await notifyExpired(await maybeExpireQuestions(), m.autoClosed || DEFAULT_CLOSED_AUTO); } catch {}
  const text = ctx.message.text || "";
  const root = render(content, "").markup;

  // Reply على رسالة إجابة الإدارة = متابعة مؤقتة لنفس السؤال، وليس سؤالًا جديدًا.
  const repliedMessageId = ctx.message.reply_to_message?.message_id;
  if (ctx.message.reply_to_message?.from?.is_bot && repliedMessageId) {
    const parent = await questionForReply(ctx.chat.id, repliedMessageId).catch(() => null);
    if (parent) {
      const followup = await addFollowup(parent.id, text).catch(() => null);
      if (followup?.limitReached) {
        return ctx.reply(m.followupLimit || DEFAULT_FOLLOWUP_LIMIT, HTML_OPTS(root));
      }
      if (followup) return ctx.reply(m.followupReceived || DEFAULT_FOLLOWUP_RECEIVED, HTML_OPTS(root));
    }
  }

  // الإجابة القديمة أو المنتهية ليست محادثة مفتوحة؛ السؤال الجديد يبدأ من زر الأسئلة.
  const repliedText = ctx.message.reply_to_message?.text || "";
  if (ctx.message.reply_to_message?.from?.is_bot && repliedText.startsWith("📩 رد على سؤالك:")) {
    return ctx.reply("لو عندك سؤال جديد، اضغط على زر «ابعت سؤالك» واكتبه هناك 👇", HTML_OPTS(root));
  }

  // 1) السؤال الطبي: يتحوّل للخط الساخن
  if (hasMedical(text, content.medicalKeywords)) {
    return ctx.reply(toHtml(m.medical || DEFAULT_MEDICAL), HTML_OPTS(root));
  }

  // 1.5) استعلام عن حجز أو موعد: رسالة واحدة، وزرار اختياري يتحدد من اللوحة
  if (hasInquiry(text, content.inquiryKeywords)) {
    const btnText = (m.inquiryButtonText || "").trim();
    const btnUrl = (m.inquiryButtonUrl || "").trim();
    const validUrl = /^https:\/\/\S+$/.test(btnUrl);
    const kb = validUrl ? new InlineKeyboard().url(btnText || "📅 فتح", btnUrl) : undefined;
    return ctx.reply(toHtml(m.inquiry || DEFAULT_INQUIRY), HTML_OPTS(kb));
  }

  // رد على خانة "اكتب سؤالك": البحث الأول، ومفيش حفظ إلا لو مفيش إجابة
  const r = ctx.message.reply_to_message;
  const rText = (r && r.text) || "";
  const prompt = m.askPrompt || DEFAULT_PROMPT;
  const isAskPrompt = rText === prompt || rText.startsWith("اكتب سؤالك") || rText.startsWith("مش واضح إنه سؤال");
  if (r && r.from?.is_bot && isAskPrompt) return handleAskReply(ctx, text, content, m, root);

  // بحث عادي في المحتوى (من غير تسجيل أي سؤال)
  const hits = searchNodes(content, text);
  if (hits.length === 1) return showHit(ctx, hits[0]);
  if (hits.length > 1) return showChoices(ctx, hits, content, m, false);

  // 4) مفيش تطابق: نسجل الكلمات اللي ما اتطابقتش (بدون أرقام)، ورد عام مع القايمة
  try {
    const words = distinctTokens(text).filter((w) => !/\d/.test(w));
    if (words.length) await trackUnmatched(words);
  } catch {}
  return ctx.reply(toHtml(m.fallback || DEFAULT_FALLBACK), HTML_OPTS(root));
});

export default webhookCallback(bot, "https");
