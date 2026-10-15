// الإحصائيات والأسئلة وسجل الضغطات في Upstash Redis (REST). أي فشل ما يوقفش البوت
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
// كل عميل بيتسجل مرة واحدة في مصدره: book (من بوت الحجز) أو none (من البحث أو بوت تاني)
export async function trackVisitor(chatId, source) {
  const id = String(chatId);
  await redis(["PFADD", "subs:all", id]);
  await redis(["PFADD", `subs:day:${todayKey()}`, id]);
  const name = source === "book" ? "book" : "none";
  await redis(["PFADD", `src:${name}`, id]);
}

// ضغطة: عداد + سجل بالوقت (السجل بيتقص كل شوية عشان يوفر أوامر)
// الساعة الحالية بتوقيت القاهرة (0 - 23)
function hourNow() {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", hour: "numeric", hourCycle: "h23" }).format(new Date());
  return String(Number(h));
}

export async function trackPress(path, label) {
  await redis(["HINCRBY", "stats:hours", hourNow(), 1]);
  await redis(["HINCRBY", `stats:press:${todayKey()}`, `${path}|${label || ""}`, 1]);
  const item = JSON.stringify({ t: Date.now(), p: path, l: label || "" });
  await redis(["LPUSH", "presslog", item]);
  if (Math.random() < 0.05) await redis(["LTRIM", "presslog", 0, 299]);
}

// كلمات العميل اللي ما اتطابقتش مع أي حاجة (بتتسجل كلمة كلمة، من غير أي رقم أو اسم)
export async function trackUnmatched(words) {
  for (const w of words.slice(0, 3)) {
    await redis(["HINCRBY", "unmatched", w, 1]);
  }
}

export async function getUnmatched() {
  const arr = (await redis(["HGETALL", "unmatched"])) || [];
  const o = toObj(arr);
  return Object.entries(o).map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count).slice(0, 50);
}

// سؤال من عميل: نص بس، من غير أي بيانات شخصية
export async function pushQuestion(text) {
  const item = JSON.stringify({ t: Date.now(), q: String(text).slice(0, 500) });
  await redis(["LPUSH", "questions", item]);
  if (Math.random() < 0.05) await redis(["LTRIM", "questions", 0, 499]);
}

import { createHash } from "crypto";
const MAX_QUESTIONS = 3;          // عدد الأسئلة المسموحة لكل عميل
const WINDOW_SECONDS = 86400;     // كل 24 ساعة

function qKey(chatId) {
  const id = createHash("sha256").update(String(chatId)).digest("hex").slice(0, 16);
  return `qrate:${id}`;
}

// كام سؤال باقي للعميل (من غير ما يزود العداد)
export async function questionsLeft(chatId) {
  const used = Number((await redis(["GET", qKey(chatId)])) ?? 0);
  return Math.max(0, MAX_QUESTIONS - used);
}

// بيزود العداد لما العميل يبعت سؤال فعلاً، ويرجع true لو لسه فيه حد
export async function questionAllowed(chatId) {
  const key = qKey(chatId);
  const n = await redis(["INCR", key]);
  if (n === 1) await redis(["EXPIRE", key, WINDOW_SECONDS]);
  return (n ?? 0) <= MAX_QUESTIONS;
}

export const MAX_QUESTIONS_COUNT = MAX_QUESTIONS;

export async function getQuestions() {
  const raw = (await redis(["LRANGE", "questions", 0, 499])) || [];
  return raw.map((r) => ({ raw: r, ...JSON.parse(r) }));
}

export async function deleteQuestion(raw) {
  await redis(["LREM", "questions", 1, raw]);
}

export async function getPressLog() {
  const raw = (await redis(["LRANGE", "presslog", 0, 299])) || [];
  return raw.map((r) => JSON.parse(r));
}

// الأرقام للوحة التحكم: آخر 7 أيام + المقارنة بامبارح
export async function getStats() {
  const perDay = await Promise.all(
    [6, 5, 4, 3, 2, 1, 0].map(async (off) => {
      const d = dayKey(-off);
      const [subs, press] = await Promise.all([
        redis(["PFCOUNT", `subs:day:${d}`]),
        redis(["HGETALL", `stats:press:${d}`]),
      ]);
      const byPath = toObj(press);
      return { date: d, newSubs: subs ?? 0, presses: sum(byPath), byPath };
    })
  );
  const hoursArr = (await redis(["HGETALL", "stats:hours"])) || [];
  const [subsAll, srcBook, srcNone] = await Promise.all([
    redis(["PFCOUNT", "subs:all"]),
    redis(["PFCOUNT", "src:book"]),
    redis(["PFCOUNT", "src:none"]),
  ]);
  const bySource = {
    "من بوت الحجز": srcBook ?? 0,
    "بدون مصدر (بحث أو بوت تاني)": srcNone ?? 0,
  };
  const agg = {};
  perDay.forEach((d) => Object.entries(d.byPath).forEach(([k, v]) => (agg[k] = (agg[k] || 0) + v)));
  const today = perDay[6];
  const yesterday = perDay[5];
  return {
    configured: !!(URL_R && TOKEN_R),
    subscribersTotal: subsAll ?? 0,
    subscribersToday: today.newSubs,
    pressesToday: today.presses,
    pressesYesterday: yesterday.presses,
    pressByPath: today.byPath,
    pressByPath7d: agg,
    bySource,
    hours: toObj(hoursArr),
    daily: perDay.map(({ date, newSubs, presses }) => ({ date, newSubs, presses })),
  };
}

// تصفير: الإحصائيات + الضغطات (الأسئلة مش بتتصفر)
export async function resetStats() {
  const keys = ["subs:all", "stats:src", "src:book", "src:none", "presslog", "stats:hours", "unmatched"];
  for (let off = 0; off < 90; off++) {
    const d = dayKey(-off);
    keys.push(`subs:day:${d}`, `stats:press:${d}`);
  }
  await redis(["DEL", ...keys]);
}

function sum(o) { return Object.values(o).reduce((a, b) => a + b, 0); }
function toObj(arr) {
  const o = {};
  for (let i = 0; i < (arr?.length || 0); i += 2) o[arr[i]] = Number(arr[i + 1]);
  return o;
}
