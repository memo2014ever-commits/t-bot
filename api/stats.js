// الإحصائيات والأسئلة وسجل الضغطات في Upstash Redis (REST). أي فشل ما يوقفش البوت
import { createHash, randomUUID } from "crypto";

const URL_R = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN_R = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export function dayKey(offset = 0) {
  const d = new Date(Date.now() + offset * 86400000);
  return d.toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
}
export const todayKey = () => dayKey(0);

export async function redis(cmd) {
  if (!URL_R || !TOKEN_R) return null;
  const r = await fetch(URL_R, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN_R}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  return j.result ?? null;
}

// عميل جديد (/start)
export async function trackVisitor(chatId, source) {
  const id = String(chatId);
  const isNew = await redis(["PFADD", "subs:all", id]);
  await redis(["PFADD", `active:day:${todayKey()}`, id]);
  await redis(["PFADD", `subs:day:${todayKey()}`, id]);
  if (isNew === 1) await redis(["PFADD", `subs:new:day:${todayKey()}`, id]);
  await redis(["PFADD", `src:${source === "book" ? "book" : "none"}`, id]);
}

// أي تفاعل فعلي مع البوت يجعل المستخدم نشطًا في هذا اليوم.
export async function trackActive(chatId) {
  await redis(["PFADD", `active:day:${todayKey()}`, String(chatId)]);
}

// الضغطة تحفظ في عداد إجمالي، وعداد يومي، وسجل تاريخي غير محدود.
function hourNow() {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", hour: "numeric", hourCycle: "h23" }).format(new Date());
  return String(Number(h));
}

export async function trackPress(path, label) {
  const d = todayKey();
  const h = hourNow();
  await Promise.all([
    redis(["HINCRBY", `stats:hours:${d}`, h, 1]),
    redis(["HINCRBY", `stats:press:${d}`, `${path}|${label || ""}`, 1]),
    redis(["LPUSH", "presslog", JSON.stringify({ t: Date.now(), p: path, l: label || "" })]),
  ]);
  // سجل الضغطات بيتقص تقريباً كل 20 ضغطة (يوفر أوامر، ويمنع الكبر بلا حد)
  if (Math.random() < 0.05) await redis(["LTRIM", "presslog", 0, 499]);
}

export async function trackUnmatched(words) {
  for (const w of words.slice(0, 3)) await redis(["HINCRBY", "unmatched", w, 1]);
}

export async function getUnmatched() {
  const arr = (await redis(["HGETALL", "unmatched"])) || [];
  const o = toObj(arr);
  return Object.entries(o).map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count).slice(0, 50);
}

export async function deleteUnmatched(word) { await redis(["HDEL", "unmatched", word]); }
export async function clearUnmatched() { await redis(["DEL", "unmatched"]); }

// سؤال معلّق لمدة 10 دقايق لحد ما العميل يختار من "تقصد؟" أو يأكد إنه يبعته
function pendKey(chatId) {
  return "pend:" + createHash("sha256").update(String(chatId)).digest("hex").slice(0, 16);
}
export async function setPending(chatId, text) {
  await redis(["SET", pendKey(chatId), String(text).slice(0, 500), "EX", 600]);
}
export async function takePending(chatId) {
  const k = pendKey(chatId);
  const v = await redis(["GET", k]);
  if (v) await redis(["DEL", k]);
  return v;
}

// صورة معلّقة لمدة 10 دقايق لحد ما العميل يكتب السؤال
function pendImgKey(chatId) {
  return "pendimg:" + createHash("sha256").update(String(chatId)).digest("hex").slice(0, 16);
}
export async function setPendingImage(chatId, url) {
  await redis(["SET", pendImgKey(chatId), String(url), "EX", 600]);
}
export async function takePendingImage(chatId) {
  const k = pendImgKey(chatId);
  const v = await redis(["GET", k]);
  if (v) await redis(["DEL", k]);
  return v;
}
export async function maybeExpireQuestions(now = Date.now()) {
  const ok = await redis(["SET", "expiry:lock", "1", "NX", "EX", 3600]);
  if (ok !== "OK") return [];
  return closeExpiredQuestions(now);
}

// ==================== مفتاح استقبال الأسئلة الجديدة ====================
// محفوظ في Redis (بيسري فوراً من غير نشر). بيأثر على إنشاء الأسئلة الجديدة فقط.
export const DEFAULT_INTAKE_MESSAGE = "نعتذر 🙏 استقبال الأسئلة الجديدة متوقف مؤقتاً حالياً.\nتقدر تتصفح القوايم والإجابات الجاهزة زي الأول، والمتابعات على أسئلتك السابقة شغالة بشكل طبيعي. هنفتح الاستقبال تاني قريباً.";
const INTAKE_KEY = "cfg:intake";
export async function getIntake() {
  const a = await redis(["HMGET", INTAKE_KEY, "enabled", "message", "by", "at"]);
  // لو Redis فشل أو مفيش إعداد: الاستقبال مفعل (الوضع الافتراضي القديم)
  return { enabled: !Array.isArray(a) || a[0] !== "0", message: (Array.isArray(a) && a[1]) || "", updatedBy: (Array.isArray(a) && a[2]) || "", updatedAt: (Array.isArray(a) && Number(a[3])) || null };
}
export async function setIntake(enabled, message, by) {
  const args = ["HSET", INTAKE_KEY, "enabled", enabled ? "1" : "0", "by", String(by).slice(0, 50), "at", Date.now()];
  if (typeof message === "string") args.push("message", message.trim().slice(0, 500));
  const r = await redis(args);
  if (r === null) return false;
  await redis(["LPUSH", "intake_log", JSON.stringify({ t: Date.now(), enabled: !!enabled, by: String(by).slice(0, 50) })]);
  return true;
}

export async function pushQuestion(text, chatId, customerName = "", attachments = [], username = "") {
  // تحقق نهائي في نفس دالة إنشاء السؤال: مهما كان مصدر الاستدعاء، السؤال الجديد ما بيتسجلش والاستقبال متوقف
  if (!(await getIntake()).enabled) return { ok: false, reason: "intake_paused" };
  await redis(["LPUSH", "questions", JSON.stringify({
    id: randomUUID(), t: Date.now(), q: String(text).slice(0, 500), chatId: String(chatId), customerName: String(customerName).slice(0, 150), username: String(username || "").slice(0, 64), status: "open",
    attachments: Array.isArray(attachments) ? attachments.slice(0, 5) : [],
  })]);
  return { ok: true };
}

const MAX_QUESTIONS = 3;
const WINDOW_SECONDS = 86400;
function qKey(chatId) { return `qrate:${createHash("sha256").update(String(chatId)).digest("hex").slice(0, 16)}`; }
export async function questionsLeft(chatId) {
  const used = Number((await redis(["GET", qKey(chatId)])) ?? 0);
  return Math.max(0, MAX_QUESTIONS - used);
}
export async function questionAllowed(chatId) {
  const key = qKey(chatId), n = await redis(["INCR", key]);
  if (n === 1) await redis(["EXPIRE", key, WINDOW_SECONDS]);
  return (n ?? 0) <= MAX_QUESTIONS;
}
export const MAX_QUESTIONS_COUNT = MAX_QUESTIONS;

export async function getQuestions() {
  const raw = (await redis(["LRANGE", "questions", 0, -1])) || [];
  return raw.map((r) => ({ raw: r, ...JSON.parse(r) }));
}
// إحصائيات حالات الأسئلة. كل سؤال أصلي بيتعد مرة واحدة (بالـ id)، والمتابعات جوه السؤال نفسه فمش بتتعد كأسئلة.
// الحالات الموجودة فعلاً: open (جديد) / followup_pending (متابعة بانتظار رد الإدارة) / awaiting_followup (تم الرد، بانتظار العميل)
// / archived (مغلق) / answered (قديم، بيظهر في الأرشيف). أي سؤال بدون حالة = open (زي ما اللوحة بتتعامل معاه).
export function computeQuestionStats(list) {
  const seen = new Set();
  const c = { total: 0, open: 0, followupPending: 0, awaitingCustomer: 0, closed: 0, legacyAnswered: 0, other: 0 };
  for (const x of list || []) {
    if (!x) continue;
    const key = x.id || x.raw;
    if (key) { if (seen.has(key)) continue; seen.add(key); }
    c.total++;
    const st = x.status || "open";
    if (st === "open") c.open++;
    else if (st === "followup_pending") c.followupPending++;
    else if (st === "awaiting_followup") c.awaitingCustomer++;
    else if (st === "archived") c.closed++;
    else if (st === "answered") c.legacyAnswered++;
    else c.other++;
  }
  // الأرشيف = اللي بيظهر في تاب الأرشيف: المغلقة + القديمة المُجاب عنها
  return { ...c, archiveTotal: c.closed + c.legacyAnswered };
}

export async function deleteQuestion(raw) { await redis(["LREM", "questions", 1, raw]); }

export const FOLLOWUP_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_FOLLOWUPS = 3;

// ==================== سجل العميل وحد المتابعات الإضافي ====================
// الزيادة مرتبطة بمعرف تيليجرام للعميل (حقل داخل hash باسم fu:extra)، والحد الافتراضي MAX_FOLLOWUPS لا يتغير.
// أي عميل بدون سجل = إضافي 0 (قيمة افتراضية آمنة للبيانات القديمة).
export const MAX_EXTRA_PER_OPERATION = 100;
const validChatId = (id) => /^\d{1,20}$/.test(String(id ?? ""));
const EXTRA_KEY = "fu:extra";   // hash واحد: chatId -> عدد المتابعات الإضافية (أمر واحد لقراءة الكل في اللوحة)

export async function getExtraFollowups(chatId) {
  if (!validChatId(chatId)) return 0;
  const v = Number((await redis(["HGET", EXTRA_KEY, String(chatId)])) ?? 0);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}
export async function getAllExtras() {
  const o = toObj((await redis(["HGETALL", EXTRA_KEY])) || []);
  Object.keys(o).forEach((k) => { if (!(o[k] > 0)) delete o[k]; });
  return o;
}
export const followupLimitFor = (extra = 0) => MAX_FOLLOWUPS + Math.max(0, Number(extra) || 0);

// يزيد الحد بشكل تراكمي وذري (HINCRBY). يرجع الحد السابق والجديد.
export async function addExtraFollowups(chatId, amount) {
  if (!validChatId(chatId)) throw new Error("معرف العميل غير صحيح");
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_EXTRA_PER_OPERATION) throw new Error("قيمة الزيادة غير صحيحة");
  const res = await redis(["HINCRBY", EXTRA_KEY, String(chatId), amount]);
  // redis() بترجّع null عند أي فشل (خطأ أو قاعدة غير مضبوطة): لازم نتأكد إن الحفظ نجح فعلاً قبل أي إشعار
  const newExtra = typeof res === "number" ? res : (typeof res === "string" && /^\d+$/.test(res) ? Number(res) : NaN);
  if (!Number.isInteger(newExtra) || newExtra < amount) throw new Error("فشل حفظ الزيادة");
  const prevExtra = newExtra - amount;
  return { prevExtra, newExtra, prevLimit: followupLimitFor(prevExtra), newLimit: followupLimitFor(newExtra) };
}

// منع تكرار نفس العملية لو الطلب اتبعت مرتين (requestId من الواجهة)
export async function claimOperation(requestId) {
  if (typeof requestId !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(requestId)) return false;
  return (await redis(["SET", `op:${requestId}`, "1", "NX", "EX", 600])) === "OK";
}

// سجل عمليات زيادة الحد (بيتحفظ كامل، من غير مسح)
export async function logLimitChange(entry) {
  await redis(["LPUSH", "followup_log", JSON.stringify(entry)]);
}
export async function getLimitLog(chatId = null) {
  const raw = (await redis(["LRANGE", "followup_log", 0, -1])) || [];
  const all = raw.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
  return chatId ? all.filter((e) => String(e.chatId) === String(chatId)) : all;
}

// آخر سؤال للعميل اتقفل بسبب وصوله للحد: يتفتح تاني عشان العميل يكمل متابعته
export async function reopenLastLimitClosed(chatId, newLimit, now = Date.now()) {
  const raw = (await redis(["LRANGE", "questions", 0, -1])) || [];
  for (let i = 0; i < raw.length; i++) {   // القائمة من الأحدث للأقدم
    let item;
    try { item = JSON.parse(raw[i]); } catch { continue; }
    if (String(item.chatId) !== String(chatId)) continue;
    if (item.status === "archived" && item.closeReason === "max_followups" && (item.followups || []).length < newLimit) {
      const updated = { ...item, status: "awaiting_followup", closedAt: null, closeReason: null, reopenedAt: now, lastActivityAt: now, followupUntil: now + FOLLOWUP_WINDOW_MS };
      const r = await redis(["LSET", "questions", i, JSON.stringify(updated)]);
      return r === null ? null : { ...updated, raw: JSON.stringify(updated) };
    }
    break; // نفحص أحدث سؤال للعميل فقط
  }
  return null;
}

export async function closeExpiredQuestions(now = Date.now()) {
  const raw = (await redis(["LRANGE", "questions", 0, -1])) || [];
  const closed = [];
  for (let i = 0; i < raw.length; i++) {
    try {
      const item = JSON.parse(raw[i]);
      if (item.status === "awaiting_followup" && item.followupUntil && item.followupUntil <= now) {
        const updated = { ...item, status: "archived", closedAt: now, closeReason: "timeout" };
        await redis(["LSET", "questions", i, JSON.stringify(updated)]);
        closed.push({ ...updated, raw: JSON.stringify(updated) });
      }
    } catch {}
  }
  return closed;
}

export async function closeQuestion(ref, reason = "manual") {
  const raw = (await redis(["LRANGE", "questions", 0, -1])) || [];
  const index = raw.findIndex((r) => {
    try { return JSON.parse(r).id === ref || r === ref; } catch { return r === ref; }
  });
  if (index < 0) return null;
  const item = JSON.parse(raw[index]);
  if (item.status === "archived") return { ...item, raw: raw[index] };
  const updated = { ...item, status: "archived", closedAt: Date.now(), closeReason: reason };
  const result = await redis(["LSET", "questions", index, JSON.stringify(updated)]);
  return result === null ? null : { ...updated, raw: JSON.stringify(updated) };
}

export async function questionForReply(chatId, messageId, now = Date.now()) {
  const raw = (await redis(["LRANGE", "questions", 0, -1])) || [];
  for (let i = 0; i < raw.length; i++) {
    try {
      const item = JSON.parse(raw[i]);
      if (String(item.chatId) !== String(chatId) || item.status !== "awaiting_followup" || !item.followupUntil || item.followupUntil <= now) continue;
      if ((item.answerMessageIds || []).map(Number).includes(Number(messageId))) return { ...item, raw: raw[i], index: i };
    } catch {}
  }
  return null;
}

export async function addFollowup(ref, text, attachments = [], now = Date.now()) {
  const raw = (await redis(["LRANGE", "questions", 0, -1])) || [];
  const index = raw.findIndex((r) => {
    try { return JSON.parse(r).id === ref || r === ref; } catch { return r === ref; }
  });
  if (index < 0) return null;
  const item = JSON.parse(raw[index]);
  const followups = Array.isArray(item.followups) ? item.followups : [];
  const limit = followupLimitFor(await getExtraFollowups(item.chatId).catch(() => 0));
  if (followups.length >= limit) return { ...item, raw: raw[index], limitReached: true };
  const updated = {
    ...item,
    status: "followup_pending",
    lastActivityAt: now,
    followups: [...followups, { t: now, text: String(text).slice(0, 1000), attachments: Array.isArray(attachments) ? attachments.slice(0, 5) : [] }],
  };
  const result = await redis(["LSET", "questions", index, JSON.stringify(updated)]);
  return result === null ? null : { ...updated, raw: JSON.stringify(updated) };
}

export async function answerQuestion(ref, answer, telegramMessageId = null) {
  const raw = (await redis(["LRANGE", "questions", 0, -1])) || [];
  const index = raw.findIndex((r) => {
    try {
      const item = JSON.parse(r);
      return item.id === ref || r === ref;
    } catch { return r === ref; }
  });
  if (index < 0) return null;

  const item = JSON.parse(raw[index]);
  if (!item.chatId) return { error: "السؤال قديم ولا يحتوي على معرّف العميل" };
  const now = Date.now();
  const followupCount = Array.isArray(item.followups) ? item.followups.length : 0;
  const limit = followupLimitFor(await getExtraFollowups(item.chatId).catch(() => 0));
  const closesNow = followupCount >= limit;
  const updated = {
    ...item,
    answer: String(answer).slice(0, 3500),
    status: closesNow ? "archived" : "awaiting_followup",
    answeredAt: now,
    lastActivityAt: now,
    followupUntil: closesNow ? null : now + FOLLOWUP_WINDOW_MS,
    closedAt: closesNow ? now : item.closedAt,
    closeReason: closesNow ? "max_followups" : item.closeReason,
    answerMessageIds: [...(item.answerMessageIds || []), ...(telegramMessageId ? [Number(telegramMessageId)] : [])].slice(-10),
    answerHistory: [...(item.answerHistory || []), { t: now, text: String(answer).slice(0, 3500), messageId: telegramMessageId ? Number(telegramMessageId) : null }].slice(-10),
  };
  const result = await redis(["LSET", "questions", index, JSON.stringify(updated)]);
  if (result === null) return null;
  return { ...updated, raw: JSON.stringify(updated) };
}

export async function updateAnswerHistory(ref, historyIndex, answer, telegramMessageId = null) {
  const raw = (await redis(["LRANGE", "questions", 0, -1])) || [];
  const index = raw.findIndex((r) => {
    try { return JSON.parse(r).id === ref || r === ref; } catch { return r === ref; }
  });
  if (index < 0) return null;
  const item = JSON.parse(raw[index]);
  const history = Array.isArray(item.answerHistory) && item.answerHistory.length
    ? [...item.answerHistory]
    : (item.answer ? [{ t: item.answeredAt || item.t || Date.now(), text: item.answer, messageId: null }] : []);
  if (!Number.isInteger(historyIndex) || historyIndex < 0 || historyIndex >= history.length) return { error: "الإجابة غير موجودة" };
  const now = Date.now();
  history[historyIndex] = { ...history[historyIndex], text: String(answer).slice(0, 3500), editedAt: now, messageId: telegramMessageId ? Number(telegramMessageId) : history[historyIndex].messageId };
  const updated = {
    ...item,
    answer: history[history.length - 1]?.text || item.answer || "",
    answerHistory: history,
    answeredAt: now,
    lastActivityAt: now,
    followupUntil: now + FOLLOWUP_WINDOW_MS,
    status: item.status === "archived" ? "archived" : "awaiting_followup",
    answerMessageIds: [...(item.answerMessageIds || []), ...(telegramMessageId ? [Number(telegramMessageId)] : [])].slice(-10),
  };
  const result = await redis(["LSET", "questions", index, JSON.stringify(updated)]);
  return result === null ? null : { ...updated, raw: JSON.stringify(updated) };
}

// لا يوجد قص للسجل؛ يعرض كل السجل التاريخي المتاح.
export async function getPressLog() {
  const raw = (await redis(["LRANGE", "presslog", 0, 499])) || [];
  return raw.map((r) => JSON.parse(r));
}

async function hoursForDate(date) { return toObj((await redis(["HGETALL", `stats:hours:${date}`])) || []); }
function peakHour(hours) {
  const entries = Object.entries(hours).map(([h, n]) => [Number(h), Number(n)]).filter(([, n]) => n > 0);
  if (!entries.length) return null;
  const max = Math.max(...entries.map(([, n]) => n));
  return { hour: entries.filter(([, n]) => n === max).map(([h]) => h).sort((a, b) => a - b)[0], count: max };
}

export async function getStats() {
  const perDay = await Promise.all([6, 5, 4, 3, 2, 1, 0].map(async (off) => {
    const date = dayKey(-off);
    const [active, newSubs, press, hours] = await Promise.all([
      redis(["PFCOUNT", `subs:day:${date}`]),
      redis(["PFCOUNT", `subs:new:day:${date}`]),
      redis(["HGETALL", `stats:press:${date}`]),
      hoursForDate(date),
    ]);
    const byPath = toObj(press);
    return { date, active: active ?? 0, newSubs: newSubs ?? 0, presses: sum(byPath), byPath, hours };
  }));
  const [subsAll, newToday, activeToday, srcBook, srcNone] = await Promise.all([
    redis(["PFCOUNT", "subs:all"]), redis(["PFCOUNT", `subs:new:day:${todayKey()}`]),
    redis(["PFCOUNT", `active:day:${todayKey()}`]), redis(["PFCOUNT", "src:book"]), redis(["PFCOUNT", "src:none"]),
  ]);
  const agg = {};
  perDay.forEach((d) => Object.entries(d.byPath).forEach(([k, v]) => (agg[k] = (agg[k] || 0) + v)));
  const last7Hours = {};
  perDay.forEach((d) => Object.entries(d.hours).forEach(([h, n]) => (last7Hours[h] = (last7Hours[h] || 0) + n)));
  return {
    configured: !!(URL_R && TOKEN_R), subscribersTotal: subsAll ?? 0,
    subscribersToday: perDay[6].active, newSubscribersToday: newToday ?? 0, activeToday: activeToday ?? 0,
    pressesToday: perDay[6].presses, pressesYesterday: perDay[5].presses,
    pressByPath: perDay[6].byPath, pressByPath7d: agg,
    bySource: { "من البوت الآخر": srcBook ?? 0, "من البحث": srcNone ?? 0 },
    hours: last7Hours, last7Hours, peakLast7: peakHour(last7Hours), daily: perDay.map(({ date, newSubs, presses }) => ({ date, newSubs, presses })),
  };
}

export async function getStatsByDay(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("تاريخ غير صحيح");
  const [hours, press] = await Promise.all([hoursForDate(date), redis(["HGETALL", `stats:press:${date}`])]);
  const byPath = toObj(press);
  return { date, hours, presses: sum(byPath), byPath, peak: peakHour(hours) };
}

// التصفير يظل يدويًا فقط، ويمسح كل المفاتيح التاريخية المطابقة بدون حد 90 يومًا.
async function deletePattern(pattern) {
  let cursor = "0";
  do {
    const result = (await redis(["SCAN", cursor, "MATCH", pattern, "COUNT", "1000"])) || ["0", []];
    cursor = String(result[0] ?? "0");
    const keys = result[1] || [];
    if (keys.length) await redis(["DEL", ...keys]);
  } while (cursor !== "0");
}
export async function resetStats() {
  await Promise.all(["subs:day:*", "subs:new:day:*", "active:day:*", "stats:press:*", "stats:hours:*"] .map(deletePattern));
  await redis(["DEL", "subs:all", "src:book", "src:none", "presslog", "stats:hours", "unmatched"]);
}

function sum(o) { return Object.values(o).reduce((a, b) => a + b, 0); }
function toObj(arr) { const o = {}; for (let i = 0; i < (arr?.length || 0); i += 2) o[arr[i]] = Number(arr[i + 1]); return o; }

// ==================== نظام الحظر ====================
function banKey(chatId) {
  return "ban:" + createHash("sha256").update(String(chatId)).digest("hex").slice(0, 16);
}

export async function banUser(chatId, reason, bannedBy) {
  const key = banKey(chatId);
  await redis(["HSET", key, "chatId", String(chatId), "reason", String(reason).slice(0, 300), "bannedAt", Date.now(), "bannedBy", String(bannedBy).slice(0, 50)]);
  await redis(["SADD", "bans:set", String(chatId)]);
}

export async function unbanUser(chatId) {
  await redis(["DEL", banKey(chatId)]);
  await redis(["SREM", "bans:set", String(chatId)]);
}

export async function isBanned(chatId) {
  const v = await redis(["HGET", banKey(chatId), "bannedAt"]);
  return v !== null;
}

export async function getBanInfo(chatId) {
  const arr = await redis(["HGETALL", banKey(chatId)]);
  if (!arr || !arr.length) return null;
  const o = {};
  for (let i = 0; i < arr.length; i += 2) o[arr[i]] = arr[i + 1];
  return o;
}

export async function getBans() {
  const ids = (await redis(["SMEMBERS", "bans:set"])) || [];
  const list = await Promise.all(ids.map(async (id) => {
    const info = await getBanInfo(id);
    return info ? { ...info, chatId: id } : null;
  }));
  return list.filter(Boolean).sort((a, b) => Number(b.bannedAt) - Number(a.bannedAt));
}
