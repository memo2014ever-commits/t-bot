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

const Q_LIST = "questions:list";
const Q_HASH = "questions:data";
const Q_MIGRATED = "questions:migrated:v1";

async function ensureQuestionStore() {
  if (!URL_R || !TOKEN_R) return;
  if (await redis(["GET", Q_MIGRATED])) return;
  const locked = await redis(["SET", "questions:migration:lock", "1", "NX", "EX", "60"]);
  if (locked !== "OK") return;
  try {
    if (await redis(["GET", Q_MIGRATED])) return;
    const old = (await redis(["LRANGE", "questions", 0, -1])) || [];
    for (const raw of old) {
      try {
        const item = JSON.parse(raw);
        if (!item.id) item.id = createHash("sha256").update(raw).digest("hex").slice(0, 24);
        await redis(["HSET", Q_HASH, item.id, JSON.stringify(item)]);
        await redis(["RPUSH", Q_LIST, item.id]);
      } catch {}
    }
    await redis(["SET", Q_MIGRATED, String(Date.now())]);
  } finally {
    await redis(["DEL", "questions:migration:lock"]);
  }
}

async function questionAt(id) {
  await ensureQuestionStore();
  const raw = await redis(["HGET", Q_HASH, String(id)]);
  if (!raw) return null;
  try { return { raw, ...JSON.parse(raw) }; } catch { return null; }
}
async function saveQuestion(item) { return await redis(["HSET", Q_HASH, String(item.id), JSON.stringify(item)]); }

export async function pushQuestion(text, chatId, customerName = "") {
  await ensureQuestionStore();
  const item = { id: randomUUID(), t: Date.now(), q: String(text).slice(0, 500), chatId: String(chatId), customerName: String(customerName).slice(0, 150), status: "open" };
  await Promise.all([saveQuestion(item), redis(["LPUSH", Q_LIST, item.id])]);
  return item;
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
  await ensureQuestionStore();
  const ids = (await redis(["LRANGE", Q_LIST, 0, 499])) || [];
  const out = [];
  for (const id of ids) { const item = await questionAt(id); if (item) out.push(item); }
  return out;
}
export async function deleteQuestion(ref) {
  const item = await questionAt(ref);
  if (!item) return;
  await Promise.all([redis(["LREM", Q_LIST, 1, item.id]), redis(["HDEL", Q_HASH, item.id])]);
}

export const FOLLOWUP_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_FOLLOWUPS = 3;

export async function closeExpiredQuestions(now = Date.now()) {
  await ensureQuestionStore();
  const last = Number((await redis(["GET", "questions:close:last"])) || 0);
  if (last && now - last < 60 * 60 * 1000) return [];
  const locked = await redis(["SET", "questions:close:lock", String(now), "NX", "EX", "120"]);
  if (locked !== "OK") return [];
  await redis(["SET", "questions:close:last", String(now)]);
  const ids = (await redis(["LRANGE", Q_LIST, 0, -1])) || [];
  const closed = [];
  for (const id of ids) {
    try {
      const item = await questionAt(id);
      if (item && item.status === "awaiting_followup" && item.followupUntil && item.followupUntil <= now) {
        const updated = { ...item, status: "archived", closedAt: now, closeReason: "timeout" };
        await saveQuestion(updated);
        closed.push(updated);
      }
    } catch {}
  }
  return closed;
}

export async function closeQuestion(ref, reason = "manual") {
  const item = await questionAt(ref);
  if (!item) return null;
  if (item.status === "archived") return item;
  const updated = { ...item, status: "archived", closedAt: Date.now(), closeReason: reason };
  const result = await saveQuestion(updated);
  return result === null ? null : { ...updated, raw: JSON.stringify(updated) };
}

export async function saveAmbiguous(chatId, text) {
  const token = randomUUID().replace(/-/g, "");
  const key = createHash("sha256").update(token).digest("hex").slice(0, 32);
  await redis(["SET", `ambiguous:${key}`, JSON.stringify({ chatId: String(chatId), text: String(text).slice(0, 500) }), "EX", "600"]);
  return token;
}
export async function consumeAmbiguous(chatId, token) {
  const key = createHash("sha256").update(String(token)).digest("hex").slice(0, 32);
  const raw = await redis(["GET", `ambiguous:${key}`]);
  if (!raw) return null;
  await redis(["DEL", `ambiguous:${key}`]);
  try { const item = JSON.parse(raw); return String(item.chatId) === String(chatId) ? item : null; } catch { return null; }
}

export async function questionForReply(chatId, messageId, now = Date.now()) {
  const items = await getQuestions();
  for (const item of items) {
    if (String(item.chatId) !== String(chatId) || item.status !== "awaiting_followup" || !item.followupUntil || item.followupUntil <= now) continue;
    if ((item.answerMessageIds || []).map(Number).includes(Number(messageId))) return item;
  }
  return null;
}

export async function addFollowup(ref, text, now = Date.now()) {
  const item = await questionAt(ref);
  if (!item) return null;
  const followups = Array.isArray(item.followups) ? item.followups : [];
  if (followups.length >= MAX_FOLLOWUPS) return { ...item, limitReached: true };
  const updated = { ...item, status: "followup_pending", lastActivityAt: now, followups: [...followups, { t: now, text: String(text).slice(0, 1000) }] };
  const result = await saveQuestion(updated);
  return result === null ? null : { ...updated, raw: JSON.stringify(updated) };
}

export async function answerQuestion(ref, answer, telegramMessageId = null) {
  const item = await questionAt(ref);
  if (!item) return null;
  if (!item.chatId) return { error: "السؤال قديم ولا يحتوي على معرّف العميل" };
  const now = Date.now();
  const followupCount = Array.isArray(item.followups) ? item.followups.length : 0;
  const closesNow = followupCount >= MAX_FOLLOWUPS;
  const updated = {
    ...item, answer: String(answer).slice(0, 3500), status: closesNow ? "archived" : "awaiting_followup", answeredAt: now,
    lastActivityAt: now, followupUntil: closesNow ? null : now + FOLLOWUP_WINDOW_MS,
    closedAt: closesNow ? now : item.closedAt, closeReason: closesNow ? "max_followups" : item.closeReason,
    answerMessageIds: [...(item.answerMessageIds || []), ...(telegramMessageId ? [Number(telegramMessageId)] : [])].slice(-10),
    answerHistory: [...(item.answerHistory || []), { t: now, text: String(answer).slice(0, 3500), messageId: telegramMessageId ? Number(telegramMessageId) : null }].slice(-10),
  };
  const result = await saveQuestion(updated);
  return result === null ? null : { ...updated, raw: JSON.stringify(updated) };
}

export async function updateAnswerHistory(ref, historyIndex, answer, telegramMessageId = null) {
  const item = await questionAt(ref);
  if (!item) return null;
  const history = Array.isArray(item.answerHistory) && item.answerHistory.length ? [...item.answerHistory] : (item.answer ? [{ t: item.answeredAt || item.t || Date.now(), text: item.answer, messageId: null }] : []);
  if (!Number.isInteger(historyIndex) || historyIndex < 0 || historyIndex >= history.length) return { error: "الإجابة غير موجودة" };
  const now = Date.now();
  history[historyIndex] = { ...history[historyIndex], text: String(answer).slice(0, 3500), editedAt: now, messageId: telegramMessageId ? Number(telegramMessageId) : history[historyIndex].messageId };
  const updated = { ...item, answer: history[history.length - 1]?.text || item.answer || "", answerHistory: history, answeredAt: now, lastActivityAt: now, followupUntil: item.status === "archived" ? null : now + FOLLOWUP_WINDOW_MS, status: item.status === "archived" ? "archived" : "awaiting_followup", answerMessageIds: [...(item.answerMessageIds || []), ...(telegramMessageId ? [Number(telegramMessageId)] : [])].slice(-10) };
  const result = await saveQuestion(updated);
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
