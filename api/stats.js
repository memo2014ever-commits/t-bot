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
// لو العميل جديد فعلاً (أول مرة يدخل)، بيتسجل كمان في "جداد اليوم"
export async function trackVisitor(chatId, source) {
  const id = String(chatId);
  const day = todayKey();
  const added = await redis(["PFADD", "subs:all", id]);
  await redis(["PFADD", `subs:day:${day}`, id]);
  if (added === 1) await redis(["PFADD", `subs:new:${day}`, id]);
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
  await redis(["HINCRBY", `stats:hours:${todayKey()}`, hourNow(), 1]);
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

const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || "");

// الأرقام للوحة التحكم
// - لو day (مثلاً 2026-10-12): أرقام اليوم ده بس
// - لو مفيش day: آخر 7 أيام + جداد اليوم + وقت الذروة
export async function getStats(day) {
  const configured = !!(URL_R && TOKEN_R);

  if (isDay(day)) {
    const [subsDay, subsNew, press, hours] = await Promise.all([
      redis(["PFCOUNT", `subs:day:${day}`]),
      redis(["PFCOUNT", `subs:new:${day}`]),
      redis(["HGETALL", `stats:press:${day}`]),
      redis(["HGETALL", `stats:hours:${day}`]),
    ]);
    const byPath = toObj(press);
    return {
      configured,
      dayMode: true,
      date: day,
      subscribersToday: subsDay ?? 0,
      newSubs: subsNew ?? 0,
      presses: sum(byPath),
      pressByPath: byPath,
      hours: toObj(hours),
    };
  }

  const offsets = [6, 5, 4, 3, 2, 1, 0];
  const perDay = await Promise.all(
    offsets.map(async (off) => {
      const d = dayKey(-off);
      const [subs, subsNew, press, hours] = await Promise.all([
        redis(["PFCOUNT", `subs:day:${d}`]),
        redis(["PFCOUNT", `subs:new:${d}`]),
        redis(["HGETALL", `stats:press:${d}`]),
        redis(["HGETALL", `stats:hours:${d}`]),
      ]);
      const byPath = toObj(press);
      return { date: d, active: subs ?? 0, newSubs: subsNew ?? 0, presses: sum(byPath), byPath, hours: toObj(hours) };
    })
  );

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
  const hours7d = {};
  perDay.forEach((d) => {
    Object.entries(d.byPath).forEach(([k, v]) => (agg[k] = (agg[k] || 0) + v));
    Object.entries(d.hours).forEach(([h, v]) => (hours7d[h] = (hours7d[h] || 0) + v));
  });

  // أكتر ساعة ذروة في آخر 7 أيام
  let peak = null;
  Object.entries(hours7d).forEach(([h, v]) => {
    if (!peak || v > peak.count) peak = { hour: Number(h), count: v };
  });

  const today = perDay[6];
  const yesterday = perDay[5];
  return {
    configured,
    dayMode: false,
    subscribersTotal: subsAll ?? 0,
    subscribersToday: today.active,
    newToday: today.newSubs,
    pressesToday: today.presses,
    pressesYesterday: yesterday.presses,
    pressByPath: today.byPath,
    pressByPath7d: agg,
    bySource,
    hours: hours7d,
    peak,
    daily: perDay.map(({ date, newSubs, presses }) => ({ date, newSubs, presses })),
  };
}

// تصفير: كل الإحصائيات والضغطات والساعات (الأسئلة مش بتتصفر)
export async function resetStats() {
  const keys = ["subs:all", "stats:src", "src:book", "src:none", "presslog", "unmatched"];
  for (const pattern of ["subs:day:*", "subs:new:*", "stats:press:*", "stats:hours:*", "stats:hours"]) {
    const found = (await redis(["KEYS", pattern])) || [];
    keys.push(...found);
  }
  const unique = [...new Set(keys)];
  for (let i = 0; i < unique.length; i += 100) {
    await redis(["DEL", ...unique.slice(i, i + 100)]);
  }
}

function sum(o) { return Object.values(o).reduce((a, b) => a + b, 0); }
function toObj(arr) {
  const o = {};
  for (let i = 0; i < (arr?.length || 0); i += 2) o[arr[i]] = Number(arr[i + 1]);
  return o;
}
