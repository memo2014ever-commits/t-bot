// تسجيل الإحصائيات ف Upstash Redis (REST) — الفشل هنا ما يوقفش البوت أبداً
const URL_R = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN_R = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export function todayKey() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
}

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

// مشترك جديد/عائد: HyperLogLog بيخزن hash مش رقم العميل الحقيقي
export async function trackVisitor(chatId, source) {
  await redis(["PFADD", "subs:all", String(chatId)]);
  await redis(["PFADD", `subs:day:${todayKey()}`, String(chatId)]);
  if (source) await redis(["HINCRBY", "stats:src", source, 1]);
}

// ضغطة على زرار: بنسجل المسار ولا حاجة تانية
export async function trackPress(path) {
  const label = path === "" ? "home" : path;
  await redis(["HINCRBY", "stats:press", label, 1]);
  await redis(["INCR", `stats:presses:day:${todayKey()}`]);
}

// كل الأرقام للوحة التحكم
export async function getStats() {
  const [subsAll, subsToday, pressesToday, pressByPath, bySource] = await Promise.all([
    redis(["PFCOUNT", "subs:all"]),
    redis(["PFCOUNT", `subs:day:${todayKey()}`]),
    redis(["GET", `stats:presses:day:${todayKey()}`]),
    redis(["HGETALL", "stats:press"]),
    redis(["HGETALL", "stats:src"]),
  ]);
  return {
    configured: !!(URL_R && TOKEN_R),
    subscribersTotal: subsAll ?? 0,
    subscribersToday: subsToday ?? 0,
    pressesToday: Number(pressesToday ?? 0),
    pressByPath: toObj(pressByPath),
    bySource: toObj(bySource),
  };
}

function toObj(arr) {
  const o = {};
  for (let i = 0; i < (arr?.length || 0); i += 2) o[arr[i]] = Number(arr[i + 1]);
  return o;
}
