// الإحصائيات في Upstash Redis (REST). أي فشل هنا ما يوقفش البوت أبداً
const URL_R = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN_R = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// تاريخ اليوم (أو أمس = -1) بتوقيت القاهرة
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
  await redis(["PFADD", "subs:all", String(chatId)]);
  await redis(["PFADD", `subs:day:${todayKey()}`, String(chatId)]);
  if (source && source !== "direct") await redis(["HINCRBY", "stats:src", source, 1]);
}

// ضغطة على زرار: أمر واحد
// بنسجل المسار + اسم الزرار وقت الضغط، عشان الإحصائيات تفضل تظهر بالاسم حتى لو الزرار اتغير أو اتحذف
export async function trackPress(path, label) {
  const key = `${path}|${label || ""}`;
  await redis(["HINCRBY", `stats:press:${todayKey()}`, key, 1]);
}

// تصفير كل الإحصائيات (آخر 90 يوم + الإجمالي)
export async function resetStats() {
  const keys = ["subs:all", "stats:src"];
  for (let off = 0; off < 90; off++) {
    const d = dayKey(-off);
    keys.push(`subs:day:${d}`, `stats:press:${d}`);
  }
  await redis(["DEL", ...keys]);
}

// كل الأرقام للوحة التحكم: آخر 7 أيام + المقارنة بامبارح
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
  const [subsAll, bySource] = await Promise.all([
    redis(["PFCOUNT", "subs:all"]),
    redis(["HGETALL", "stats:src"]),
  ]);

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
    bySource: toObj(bySource),
    daily: perDay.map(({ date, newSubs, presses }) => ({ date, newSubs, presses })),
  };
}

function sum(o) { return Object.values(o).reduce((a, b) => a + b, 0); }

function toObj(arr) {
  const o = {};
  for (let i = 0; i < (arr?.length || 0); i += 2) o[arr[i]] = Number(arr[i + 1]);
  return o;
}
