// خادم لوحة التحكم: تسجيل دخول بدورين (أدمن / محرر)، وقراءة وحفظ وسجل نسخ من GitHub
// كل الأسرار في متغيرات البيئة في Vercel، ومش ظاهرة للمتصفح
import { timingSafeEqual, createHash } from "crypto";
import { getStats, getStatsByDay, getOverviewDay, getQuestions, deleteQuestion, answerQuestion, updateAnswerHistory, closeExpiredQuestions, closeQuestion, getPressLog, getUnmatched, deleteUnmatched, clearUnmatched, banUser, unbanUser, getBans, getBanInfo, redis,
  getIntake, setIntake, computeQuestionStats, DEFAULT_INTAKE_MESSAGE, MAX_FOLLOWUPS, MAX_EXTRA_PER_OPERATION, getExtraFollowups, getAllExtras, limitForItem, followupLimitState, adjustQuestionExtra, clearPermanentExtra, claimOperation, logLimitChange, getLimitLog } from "./stats.js";
import { phonesSharedOnDay, phoneFeatureEnabled, phoneSharedCount, customerMap, listCustomers, customerDetail } from "./customers.js";
import { explainError } from "./errors.js";
import { registryCount, backfillRegistry, registeredOnDay } from "./registry.js";
import { getNotifyConfig, setNotifyConfig, listNotifyChats, unlinkNotifyChat, createLinkCode, getNotifyLast, sendNotifyTest, botUsername, MAX_NOTIFY_CHATS, LINK_CODE_TTL } from "./notify.js";

const {
  ADMIN_USER, ADMIN_PASS,          // الأدمن: يعدّل ويحذف
  EDITOR_USER, EDITOR_PASS,        // المحرر (اختياري): يعدّل ومايحذفش
  GITHUB_TOKEN, GITHUB_REPO,
  GITHUB_FILE = "content.json", GITHUB_BRANCH = "main",
  BOT_TOKEN,
} = process.env;

const API = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`;
const GH_HEADERS = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "legan-admin",
};

function safeEq(a = "", b = "") {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && timingSafeEqual(A, B);
}

// يرجع الدور: "admin" أو "editor" أو null
function authenticate(u, p) {
  if (ADMIN_USER && safeEq(u, ADMIN_USER) && safeEq(p, ADMIN_PASS)) return "admin";
  if (EDITOR_USER && safeEq(u, EDITOR_USER) && safeEq(p, EDITOR_PASS)) return "editor";
  return null;
}

function countNodes(n) {
  return 1 + (n.items || []).reduce((a, c) => a + countNodes(c), 0);
}

function validate(node, isRoot = true, depth = 0) {
  if (depth > 4) return "الشجرة أعمق من 4 مستويات";
  if (!node || typeof node.text !== "string") return "فيه عنصر من غير نص";
  if (node.text.length > 3500) return "نص طويل جداً (الحد 3500 حرف)";
  if (!isRoot && (!node.label || typeof node.label !== "string")) return "فيه زرار من غير اسم";
  if (node.action !== undefined && node.action !== "ask") return "نوع الزرار غلط";
  if (node.keywords !== undefined && (!Array.isArray(node.keywords) || node.keywords.length > 30 ||
      node.keywords.some((k) => typeof k !== "string" || k.length > 40))) {
    return "كلمات الاستدعاء لازم تكون قايمة كلمات قصيرة (حد 30 كلمة)";
  }
  if (node.url !== undefined && node.url !== "" && !/^https:\/\/[^\s]+$/.test(node.url)) return "الرابط لازم يبدأ بـ https://";
  if (node.items !== undefined && !Array.isArray(node.items)) return "items لازم تكون قايمة";
  if ((node.items || []).length > 50) return "الحد 50 زرار في القايمة الواحدة";
  for (const child of node.items || []) {
    const err = validate(child, false, depth + 1);
    if (err) return err;
  }
  return null;
}

// خطأ من خدمة خارجية (تيليجرام / GitHub / ImgBB) بسببه الحقيقي، علشان اللوحة تشرحه
function extError(source, message, extra = {}) { return Object.assign(new Error(message), { source }, extra); }
async function ghFetch(url, opts) {
  try { return await fetch(url, opts); } catch (e) { throw extError("github", e?.message || "network", { network: true }); }
}
async function readCurrent(ref = GITHUB_BRANCH) {
  const r = await ghFetch(`${API}?ref=${ref}`, { headers: GH_HEADERS });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.content) throw extError("github", j.message || `HTTP ${r.status}`, { status: r.status });
  return { sha: j.sha, content: JSON.parse(Buffer.from(j.content, "base64").toString("utf8")) };
}

async function sendTelegram(chatId, answer, messages = {}, finalAnswer = false, followupCount = 0, imageUrl = null, limit = MAX_FOLLOWUPS) {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN غير مضبوط على السيرفر");
  const text = `📩 رد على سؤالك:\n\n${answer}${finalAnswer ? "" : (followupCount > 0 ? `\n\n📩 المتابعة: ${followupCount}/${limit}` : (messages.answerFooter || `\n\n📌 مسموح بحد أقصى ${limit} متابعات على نفس السؤال. اضغط Reply للمتابعة، ولسؤال جديد استخدم «ابعت سؤالك».`))}`;
  const replyMarkup = finalAnswer ? {} : { reply_markup: { force_reply: true, input_field_placeholder: messages.followupPlaceholder || "اكتب متابعة السؤال هنا..." } };
  let r, j;
  try {
    if (imageUrl) {
      r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, photo: imageUrl, caption: text, ...replyMarkup }),
      });
    } else {
      r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, ...replyMarkup }),
      });
    }
  } catch (e) { throw extError("telegram", e?.message || "network", { network: true }); }
  j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw extError("telegram", j.description || "فشل إرسال الإجابة إلى تيليجرام", { status: r.status, retryAfter: j.parameters?.retry_after });
  return j.result;
}

const DEFAULT_LIMIT_INCREASED = "🎁 تمت زيادة عدد المتابعات المسموح لك بها 🌷\nتقدر دلوقتي تكمل متابعة استفسارك بالرد (Reply) على آخر رد وصلك من الإدارة.";

async function sendCloseNotice(chatId, automatic = false, messages = {}) {
  if (!BOT_TOKEN || !chatId) return;
  const text = automatic ? (messages.autoClosed || "🔒 تم إغلاق سؤالك تلقائيًا لعدم وجود متابعة خلال 24 ساعة.\n\nإذا كان لديك استفسار جديد، استخدم زر «ابعت سؤالك» 👇") : (messages.manualClosed || "🔒 تم إغلاق هذا السؤال من الإدارة.\n\nإذا كان لديك استفسار جديد، استخدم زر «ابعت سؤالك» 👇");
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text }) });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method" });

  const { username, password, action, content, message, ref, answer, answerIndex } = req.body || {};
  const role = authenticate(username, password);
  if (!role) return res.status(401).json({ error: "اسم المستخدم أو الباسورد غلط" });

  try {
    if (action === "get") {
      const { content: data } = await readCurrent();
      return res.json({ content: data, role });
    }

    if (action === "stats") {
      const st = await getStats();
      // إحصائيات مشاركة الأرقام: بدون أي رقم هاتف. الإجمالي هو نفس "إجمالي المشتركين (تقريبي)" الموجود بالفعل
      const shared = await phoneSharedCount().catch(() => 0);
      const total = Math.max(Number(st.subscribersTotal) || 0, shared);
      st.questionStats = computeQuestionStats(await getQuestions().catch(() => []));
      st.intake = await getIntake();
      // قاعدة المشتركين المسجّلين بالـ ID (مختلفة عن "إجمالي المشتركين (تقريبي)" القديم)
      const regCount = await registryCount().catch(() => 0);
      st.registry = { count: regCount, coverage: Number(st.subscribersTotal) > 0 ? Math.min(100, Math.round((regCount / Number(st.subscribersTotal)) * 1000) / 10) : 0 };
      st.phones = {
        enabled: phoneFeatureEnabled(), shared, notShared: Math.max(0, total - shared), total,
        rate: total > 0 ? Math.min(100, Math.round((shared / total) * 1000) / 10) : 0,
      };
      return res.json(st);
    }

    if (action === "statsDay") {
      if (typeof ref !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(ref)) {
        return res.status(400).json({ error: "تاريخ غير صحيح" });
      }
      return res.json(await getStatsByDay(ref));
    }

    // ملخص يوم محدد للكروت العلوية (قسم الإحصائيات)
    if (action === "overviewDay") {
      if (typeof ref !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(ref)) return res.status(400).json({ error: "تاريخ غير صحيح" });
      return res.json(await getOverviewDay(ref));
    }

    // إحصائيات العملاء ليوم محدد: المشاركون بأرقامهم + المسجّلون بالـ ID
    if (action === "customersDay") {
      if (typeof ref !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(ref)) return res.status(400).json({ error: "تاريخ غير صحيح" });
      const [shared, registered] = await Promise.all([phonesSharedOnDay(ref).catch(() => 0), registeredOnDay(ref).catch(() => 0)]);
      return res.json({ date: ref, shared, registered });
    }

    if (action === "questions") {
      const expired = await closeExpiredQuestions();
      // نكلّم GitHub بس لو فيه أسئلة انتهت فعلاً (بدل كل تحديث): ده كان أكبر سبب لبطء الصفحة
      if (expired.length) {
        const systemMessages = (await readCurrent()).content.messages || {};
        await Promise.all(expired.map((x) => sendCloseNotice(x.chatId, true, systemMessages).catch(() => {})));
      }
      // extras: زيادات حد المتابعات لكل عميل (أمر Redis واحد)، والواجهة تحسب الحد = الافتراضي + الزيادة
      const [questions, extras, intake] = await Promise.all([getQuestions(), getAllExtras().catch(() => ({})), getIntake()]);
      // بيانات أصحاب الأسئلة (3 أوامر Redis مهما كان العدد). رقم الهاتف للأدمن فقط
      const customers = await customerMap(questions.map((x) => x.chatId), { withPhones: role === "admin" }).catch(() => ({}));
      return res.json({ questions, customers, intake: { ...intake, defaultMessage: DEFAULT_INTAKE_MESSAGE }, phoneFeature: phoneFeatureEnabled(), extras, defaultFollowupLimit: MAX_FOLLOWUPS });
    }

    if (action === "answerQuestion") {
      if (typeof ref !== "string" || ref.length > 200) return res.status(400).json({ error: "السؤال غير صحيح" });
      if (typeof answer !== "string" || !answer.trim() || answer.length > 3500) {
        return res.status(400).json({ error: "الإجابة مطلوبة وبحد أقصى 3500 حرف" });
      }
      const questions = await getQuestions();
      const question = questions.find((x) => x.id === ref || x.raw === ref);
      if (!question) return res.status(404).json({ error: "السؤال غير موجود" });
      if (!question.chatId) return res.status(400).json({ error: "السؤال قديم ولا يحتوي على معرّف العميل" });
      const systemMessages = (await readCurrent()).content.messages || {};
      const followupCount = (question.followups || []).length;
      const imageUrl = typeof req.body.imageUrl === "string" && /^https:\/\//.test(req.body.imageUrl) ? req.body.imageUrl : null;
      const limit = limitForItem(question, await getExtraFollowups(question.chatId).catch(() => 0));
      const telegramMessage = await sendTelegram(question.chatId, answer.trim(), systemMessages, followupCount >= limit, followupCount, imageUrl, limit);
      const updated = await answerQuestion(ref, answer.trim(), telegramMessage.message_id);
      if (!updated || updated.error) return res.status(500).json({ error: updated?.error || "فشل تحديث حالة السؤال" });
      if (updated.status === "archived") await sendCloseNotice(updated.chatId, false, systemMessages).catch(() => {});
      return res.json({ ok: true, question: updated });
    }

    if (action === "editAnswer") {
      if (typeof ref !== "string" || ref.length > 200 || !Number.isInteger(answerIndex) || answerIndex < 0) return res.status(400).json({ error: "بيانات الإجابة غير صحيحة" });
      if (typeof answer !== "string" || !answer.trim() || answer.length > 3500) return res.status(400).json({ error: "الإجابة مطلوبة وبحد أقصى 3500 حرف" });
      const questions = await getQuestions();
      const question = questions.find((x) => x.id === ref || x.raw === ref);
      if (!question) return res.status(404).json({ error: "السؤال غير موجود" });
      if (!question.chatId) return res.status(400).json({ error: "السؤال لا يحتوي على معرّف العميل" });
      const systemMessages = (await readCurrent()).content.messages || {};
      const editLimit = limitForItem(question, await getExtraFollowups(question.chatId).catch(() => 0));
      const telegramMessage = await sendTelegram(question.chatId, answer.trim(), systemMessages, question.status === "archived", (question.followups || []).length, null, editLimit);
      const updated = await updateAnswerHistory(ref, answerIndex, answer.trim(), telegramMessage.message_id);
      if (!updated || updated.error) return res.status(500).json({ error: updated?.error || "فشل تحديث الإجابة" });
      return res.json({ ok: true, question: updated });
    }

    if (action === "closeQuestion") {
      if (typeof ref !== "string" || ref.length > 200) return res.status(400).json({ error: "السؤال غير صحيح" });
      const updated = await closeQuestion(ref, "manual");
      if (!updated) return res.status(404).json({ error: "السؤال غير موجود" });
      const systemMessages = (await readCurrent()).content.messages || {};
      await sendCloseNotice(updated.chatId, false, systemMessages).catch(() => {});
      return res.json({ ok: true, question: updated });
    }

    if (action === "delq") {
      if (typeof ref !== "string" || ref.length > 1000) return res.status(400).json({ error: "سؤال غلط" });
      await deleteQuestion(ref);
      return res.json({ ok: true });
    }

    if (action === "unmatched") {
      return res.json({ words: await getUnmatched() });
    }

    if (action === "delunmatched") {
      if (typeof ref !== "string" || !ref.trim() || ref.length > 100) return res.status(400).json({ error: "كلمة غلط" });
      await deleteUnmatched(ref);
      return res.json({ ok: true });
    }

    if (action === "clearunmatched") {
      await clearUnmatched();
      return res.json({ ok: true });
    }

    if (action === "uploadImage") {
      const { image } = req.body || {};
      if (typeof image !== "string" || !image) return res.status(400).json({ error: "الصورة مطلوبة" });
      const { IMGBB_API_KEY } = process.env;
      if (!IMGBB_API_KEY) return res.status(500).json({ error: "IMGBB_API_KEY غير مضبوط" });
      const form = new URLSearchParams({ key: IMGBB_API_KEY, image });
      let r;
      try { r = await fetch("https://api.imgbb.com/1/upload", { method: "POST", body: form }); }
      catch (e) { throw extError("imgbb", e?.message || "network", { network: true }); }
      const j = await r.json().catch(() => ({}));
      if (!j.success) throw extError("imgbb", j.error?.message || "فشل رفع الصورة", { status: r.status });
      return res.json({ url: j.data.url });
    }

    // ---------- مفتاح استقبال الأسئلة الجديدة ----------
    if (action === "getIntake") {
      return res.json({ ...(await getIntake()), defaultMessage: DEFAULT_INTAKE_MESSAGE });
    }
    if (action === "setIntake") {
      if (role !== "admin") return res.status(403).json({ error: "التحكم في استقبال الأسئلة للأدمن بس" });
      if (typeof req.body.enabled !== "boolean") return res.status(400).json({ error: "القيمة غير صحيحة" });
      const msg = req.body.message;
      if (msg !== undefined && (typeof msg !== "string" || msg.length > 500)) return res.status(400).json({ error: "رسالة الاعتذار حتى 500 حرف" });
      const ok = await setIntake(req.body.enabled, msg, username);
      if (!ok) return res.status(500).json({ error: "فشل حفظ الإعداد، لم يتم تغيير أي شيء" });
      return res.json({ ok: true, ...(await getIntake()), defaultMessage: DEFAULT_INTAKE_MESSAGE });
    }

    // ---------- قاعدة المشتركين: استيراد المعروفين دلوقتي (أدمن فقط) ----------
    if (action === "registryBackfill") {
      if (role !== "admin") return res.status(403).json({ error: "استيراد المشتركين للأدمن بس" });
      return res.json({ ok: true, ...(await backfillRegistry()) });
    }

    // ---------- تنبيهات الموظفين على تيليجرام (أدمن فقط) ----------
    if (typeof action === "string" && action.startsWith("notify")) {
      if (role !== "admin") return res.status(403).json({ error: "إعدادات التنبيهات للأدمن بس" });
      if (action === "notifyGet") {
        return res.json({ config: await getNotifyConfig(), chats: await listNotifyChats(), last: await getNotifyLast(), bot: await botUsername(), maxChats: MAX_NOTIFY_CHATS, codeTtl: LINK_CODE_TTL });
      }
      if (action === "notifySet") {
        const r = await setNotifyConfig(req.body.config && typeof req.body.config === "object" ? req.body.config : {});
        if (r.error) return res.status(400).json({ error: r.error });
        return res.json({ ok: true, config: r.config });
      }
      if (action === "notifyLinkCode") {
        const r = await createLinkCode();
        if (r.error) return res.status(400).json({ error: r.error });
        return res.json({ ok: true, code: r.code, expiresIn: r.expiresIn, bot: await botUsername() });
      }
      if (action === "notifyUnlink") {
        if (typeof ref !== "string" || !/^-?\d{1,20}$/.test(ref.trim())) return res.status(400).json({ error: "معرف المحادثة غير صحيح" });
        const ok = await unlinkNotifyChat(ref.trim());
        return ok ? res.json({ ok: true }) : res.status(404).json({ error: "المحادثة دي مش مربوطة" });
      }
      if (action === "notifyTest") {
        const r = await sendNotifyTest();
        if (r.error) return res.status(400).json({ error: r.error });
        return res.json(r);
      }
    }

    // ---------- العملاء وأرقام الهواتف ----------
    // القوائم لا تحتوي على أرقام هواتف أبداً. الرقم يظهر في customerDetail وبجوار الأسئلة للأدمن فقط
    if (action === "customers") {
      const filter = ["all", "shared", "notshared"].includes(req.body.filter) ? req.body.filter : "all";
      const q = typeof req.body.q === "string" ? req.body.q.slice(0, 60) : "";
      const rows = await listCustomers({ questions: await getQuestions(), filter, q, withPhones: role === "admin" });
      // تقسيم صفحات من السيرفر (50 عميل في الصفحة) علشان القايمة ما تطولش
      const PAGE = 50, pages = Math.max(1, Math.ceil(rows.length / PAGE));
      const page = Math.min(pages, Math.max(1, parseInt(req.body.page, 10) || 1));
      return res.json({ customers: rows.slice((page - 1) * PAGE, page * PAGE), total: rows.length, page, pages, pageSize: PAGE });
    }

    if (action === "customerDetail") {
      if (typeof ref !== "string" || !/^\d{1,20}$/.test(ref.trim())) return res.status(400).json({ error: "معرف العميل غير صحيح" });
      const c = await customerDetail(ref.trim(), { withPhones: role === "admin" });
      const mine = (await getQuestions()).filter((x) => String(x.chatId) === ref.trim());
      const base = c || { chatId: ref.trim(), name: mine.find((x) => x.customerName)?.customerName || "", username: "", firstSeen: null, phoneState: "phone_not_requested", hasPhone: false };
      return res.json({ customer: { ...base, questionsCount: mine.length, extraFollowups: await getExtraFollowups(ref.trim()) }, canSeePhone: role === "admin" });
    }

    // ---------- حد المتابعات لكل عميل (أدمن فقط، والتحقق هنا في السيرفر) ----------
    if (action === "followupLimitInfo") {
      if (role !== "admin") return res.status(403).json({ error: "تعديل حد المتابعات للأدمن بس" });
      if (typeof ref !== "string" || !/^\d{1,20}$/.test(ref.trim())) return res.status(400).json({ error: "معرف العميل غير صحيح" });
      const chatId = ref.trim();
      const st = await followupLimitState(chatId);
      const mine = (await getQuestions()).filter((x) => String(x.chatId) === chatId);
      return res.json({
        chatId, customerName: mine.find((x) => x.customerName)?.customerName || "", defaultLimit: MAX_FOLLOWUPS,
        ...st, log: (await getLimitLog(chatId)).slice(0, 20),
      });
    }

    // زيادة / نقص / حذف: بتخص السؤال الحالي للعميل وبتنتهي بانتهائه. "clearPermanent" بيحذف الإضافي الدائم القديم.
    if (action === "adjustFollowupLimit" || action === "increaseFollowupLimit") {
      if (role !== "admin") return res.status(403).json({ error: "تعديل حد المتابعات للأدمن بس" });
      if (typeof ref !== "string" || !/^\d{1,20}$/.test(ref.trim())) return res.status(400).json({ error: "معرف العميل غير صحيح" });
      const op = action === "increaseFollowupLimit" ? "add" : req.body.op;
      if (!["add", "sub", "clear", "clearPermanent"].includes(op)) return res.status(400).json({ error: "عملية غير معروفة" });
      const amount = req.body.amount;
      if ((op === "add" || op === "sub") && (!Number.isInteger(amount) || amount < 1 || amount > MAX_EXTRA_PER_OPERATION)) {
        return res.status(400).json({ error: `أدخل رقم صحيح من 1 إلى ${MAX_EXTRA_PER_OPERATION}` });
      }
      const chatId = ref.trim();
      if (!(await claimOperation(req.body.requestId))) {
        return res.status(409).json({ error: "العملية دي اتنفذت قبل كده أو الطلب غير صالح. حدّث الصفحة وراجع الحد الحالي." });
      }
      let change;
      try { change = op === "clearPermanent" ? await clearPermanentExtra(chatId) : await adjustQuestionExtra(chatId, op, amount); }
      catch (e) { change = { error: "فشل حفظ التغيير، لم يتم تغيير أي شيء", fatal: true }; }
      if (change.error) {
        await redis(["DEL", `op:${req.body.requestId}`]);   // العملية ما حصلتش: نسمح بإعادة المحاولة
        return res.status(change.fatal ? 500 : 400).json({ error: change.error });
      }
      const mine = (await getQuestions()).filter((x) => String(x.chatId) === chatId);
      const customerName = mine.find((x) => x.customerName)?.customerName || "";
      await logLimitChange({ t: Date.now(), chatId, customerName, admin: String(username).slice(0, 50), op, scope: op === "clearPermanent" ? "permanent" : "question", questionId: change.questionId || null, prevLimit: change.prevLimit, added: change.delta, newLimit: change.newLimit }).catch(() => {});

      // الإشعار للعميل بعد نجاح الحفظ، وللزيادة فقط (مش للنقص أو الحذف). فشل الإشعار ما يلغيش التغيير.
      let notified = false;
      if (op === "add") {
        try {
          const systemMessages = (await readCurrent()).content.messages || {};
          const text = systemMessages.followupLimitIncreased || DEFAULT_LIMIT_INCREASED;
          const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text }) });
          notified = r.ok;
        } catch {}
      }
      return res.json({ ok: true, op, prevLimit: change.prevLimit, newLimit: change.newLimit, delta: change.delta, notified, reopened: !!change.reopened });
    }

    if (action === "resetQuestionLimit") {
      if (role !== "admin") return res.status(403).json({ error: "للأدمن بس" });
      if (typeof ref !== "string" || !/^\d+$/.test(ref.trim())) return res.status(400).json({ error: "معرف العميل غير صحيح" });
      const key = `qrate:${createHash("sha256").update(ref.trim()).digest("hex").slice(0, 16)}`;
      await redis(["DEL", key]);
      return res.json({ ok: true });
    }

    if (action === "banUser") {
      if (role !== "admin") return res.status(403).json({ error: "الحظر للأدمن بس" });
      if (typeof ref !== "string" || !/^\d+$/.test(ref.trim())) return res.status(400).json({ error: "معرف العميل غير صحيح" });
      const reason = typeof message === "string" && message.trim() ? message.trim().slice(0, 300) : "لم يُذكر سبب";
      await banUser(ref.trim(), reason, username);
      return res.json({ ok: true });
    }

    if (action === "unbanUser") {
      if (role !== "admin") return res.status(403).json({ error: "رفع الحظر للأدمن بس" });
      if (typeof ref !== "string" || !/^\d+$/.test(ref.trim())) return res.status(400).json({ error: "معرف العميل غير صحيح" });
      await unbanUser(ref.trim());
      return res.json({ ok: true });
    }

    if (action === "getBans") {
      return res.json({ bans: await getBans() });
    }

    if (action === "getBanInfo") {
      if (typeof ref !== "string" || !/^\d+$/.test(ref.trim())) return res.status(400).json({ error: "معرف العميل غير صحيح" });
      return res.json({ ban: await getBanInfo(ref.trim()) });
    }

    if (action === "presslog") {
      return res.json({ log: await getPressLog() });
    }

    if (action === "history") {
      const r = await ghFetch(
        `https://api.github.com/repos/${GITHUB_REPO}/commits?path=${GITHUB_FILE}&sha=${GITHUB_BRANCH}&per_page=20`,
        { headers: GH_HEADERS }
      );
      const list = await r.json().catch(() => ({}));
      if (!r.ok || !Array.isArray(list)) throw extError("github", list.message || `HTTP ${r.status}`, { status: r.status });
      return res.json({
        commits: list.map((c) => ({
          sha: c.sha,
          date: c.commit.author.date,
          message: c.commit.message,
        })),
      });
    }

    if (action === "version") {
      if (!/^[0-9a-f]{7,40}$/.test(ref || "")) return res.status(400).json({ error: "نسخة غلط" });
      const { content: data } = await readCurrent(ref);
      return res.json({ content: data });
    }

    if (action === "save") {
      const err = validate(content);
      if (err) return res.status(400).json({ error: err });
      if (content.inquiryKeywords !== undefined) {
        if (!Array.isArray(content.inquiryKeywords) || content.inquiryKeywords.length > 100 ||
            content.inquiryKeywords.some((w) => typeof w !== "string" || w.length > 40)) {
          return res.status(400).json({ error: "كلمات الاستعلام لازم تكون قايمة كلمات قصيرة (حد 100 كلمة)" });
        }
      }
      if (content.medicalKeywords !== undefined) {
        if (!Array.isArray(content.medicalKeywords) || content.medicalKeywords.length > 100 ||
            content.medicalKeywords.some((w) => typeof w !== "string" || w.length > 40)) {
          return res.status(400).json({ error: "كلمات الطب لازم تكون قايمة كلمات قصيرة (حد 100 كلمة)" });
        }
      }
      if (content.questionWords !== undefined) {
        if (!Array.isArray(content.questionWords) || content.questionWords.length > 200 ||
            content.questionWords.some((w) => typeof w !== "string" || w.length > 30)) {
          return res.status(400).json({ error: "كلمات السؤال لازم تكون قايمة كلمات قصيرة (حد 200 كلمة)" });
        }
      }
      if (content.messages !== undefined) {
        if (typeof content.messages !== "object") return res.status(400).json({ error: "رسايل النظام غلط" });
        for (const v of Object.values(content.messages)) {
          if (typeof v !== "string" || v.length > 500) return res.status(400).json({ error: "رسالة نظام طويلة أو غلط (الحد 500 حرف)" });
        }
      }

            if (content.quickReplies !== undefined) {
        if (!Array.isArray(content.quickReplies) || content.quickReplies.length > 50 ||
            content.quickReplies.some((q) => !q || typeof q.title !== "string" || q.title.length > 80 || typeof q.text !== "string" || q.text.length > 3500)) {
          return res.status(400).json({ error: "الإجابات السريعة: 50 إجابة كحد أقصى، العنوان 80 حرف، والنص 3500 حرف" });
        }
      }
      const cur = await readCurrent();
      // المحرر ما يقدرش يحذف: لو عدد الزراير قل، نرفض
      if (role === "editor" && countNodes(content) < countNodes(cur.content)) {
        return res.status(403).json({ error: "المحرر مايقدرش يحذف زراير، اطلب من الأدمن" });
      }

      const r = await ghFetch(API, {
        method: "PUT",
        headers: GH_HEADERS,
        body: JSON.stringify({
          message: (message || "تعديل من لوحة التحكم").slice(0, 200),
          content: Buffer.from(JSON.stringify(content, null, 2)).toString("base64"),
          sha: cur.sha,
          branch: GITHUB_BRANCH,
        }),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw extError("github", j.message || `HTTP ${r.status}`, { status: r.status }); }
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: "action غلط" });
  } catch (e) {
    // بنشرح السبب للمستخدم وبنسجّله في Vercel Logs (من غير أسرار أو بيانات عملاء)
    const info = explainError(e, action);
    console.error("[admin]", info.log);
    return res.status(info.status).json({ error: info.message, code: info.code });
  }
}
