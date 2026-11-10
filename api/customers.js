// سجل العملاء (تدريجي / Lazy) + مشاركة رقم الهاتف المشفّر
// - لا يوجد ترحيل جماعي: العميل القديم بدون حالة = phone_not_requested، وتتسجل حالته عند أول تفاعل له فقط.
// - رقم الهاتف بيتخزن مشفّر AES-256-GCM بمفتاح من متغير البيئة PHONE_ENC_KEY (مش في الكود ولا GitHub).
// - مفيش أي طباعة لأرقام الهواتف في الـ logs.
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { redis, cairoDayOf } from "./stats.js";

// ثلاث hashes (كل hash: chatId -> قيمة)، عشان قراءتها كلها أمر Redis واحد
const INFO = "cu:info";   // JSON: { n: الاسم, u: username, fs: أول تفاعل مسجل (ms), pt: وقت مشاركة الرقم }
const PHS = "cu:phs";     // الحالة: phone_shared | phone_skipped | phone_prompted (الغياب = phone_not_requested)
const PH = "cu:ph";       // رقم الهاتف المشفّر

export const PHONE_STATES = ["phone_shared", "phone_skipped", "phone_prompted", "phone_not_requested"];

// ---------- التشفير ----------
function loadKey() {
  const raw = (process.env.PHONE_ENC_KEY || "").trim();
  if (!raw) return null;
  try {
    const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    return buf.length === 32 ? buf : null;
  } catch { return null; }
}
// الميزة كلها بتشتغل بس لو المفتاح موجود وصحيح (32 بايت). غير كده: مفيش طلب رقم ولا تخزين.
export const phoneFeatureEnabled = () => loadKey() !== null;

export function encryptPhone(chatId, phone) {
  const key = loadKey();
  if (!key) throw new Error("PHONE_ENC_KEY missing or invalid");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(String(chatId)));   // الرقم مربوط بمعرف صاحبه: نقله لعميل تاني بيفشل في فك التشفير
  const ct = Buffer.concat([c.update(String(phone), "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

// بيرجع الرقم أو null لو فشل فك التشفير (مفتاح غلط/بيانات تالفة). مبيرميش خطأ ومبيطبعش الرقم.
export function decryptPhone(chatId, blob) {
  try {
    const key = loadKey();
    if (!key || typeof blob !== "string") return null;
    const [v, iv, tag, ct] = blob.split(".");
    if (v !== "v1" || !iv || !tag || !ct) return null;
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    d.setAAD(Buffer.from(String(chatId)));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  } catch { return null; }
}

// "+20 100 123 4567" -> "+201001234567" ، ويرفض اللي مش رقم منطقي (7-15 رقم حسب E.164)
export function normalizePhone(p) {
  const digits = String(p ?? "").replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? "+" + digits : null;
}

const validId = (id) => /^\d{1,20}$/.test(String(id ?? ""));
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const fullName = (from) => [from?.first_name, from?.last_name].filter(Boolean).join(" ").slice(0, 150);

// ---------- سجل العميل (الاسم / username / أول تفاعل) ----------
// بيحفظ أول تفاعل مرة واحدة فقط (fs)، ويحدّث الاسم والـ username لو اتغيروا
export async function upsertInfo(from, extra = {}, now = Date.now()) {
  if (!from || !validId(from.id)) return;
  const id = String(from.id);
  const cur = parse(await redis(["HGET", INFO, id])) || {};
  const next = { ...cur, n: fullName(from) || cur.n || "", u: from.username || "", fs: cur.fs || now, ...extra };
  if (JSON.stringify(next) !== JSON.stringify(cur)) await redis(["HSET", INFO, id, JSON.stringify(next)]);
}

// ---------- حالة مشاركة الرقم + جدول التذكير ----------
// القيمة المخزنة في cu:phs:  الحالة|عدد مرات الظهور|وقت آخر ظهور|وقت بداية الدورة   (والقيم القديمة بدون | بتتقرأ عادي)
//  - phone_prompted (تجاهل الطلب): يظهر في أول تفاعل بعد كل 24 ساعة، لحد 5 مرات.
//  - phone_skipped (ضغط "بدون مشاركة"): يتذكّر كل 3 أيام لمدة 30 يوم من وقت اختياره، وبعدها يقف والزرار يفضل اختياري.
//  - phone_shared: مفيش طلب تاني.
export const PROMPT_POLICY = {
  ignoredMax: 5, ignoredEveryMs: 24 * 3600e3,
  skippedEveryMs: 3 * 24 * 3600e3, skippedWindowMs: 30 * 24 * 3600e3,
};
const baseState = (v) => String(v ?? "").split("|")[0];
function parseState(v) {
  if (!v) return null;
  const [state, c, last, start] = String(v).split("|");
  return { state, count: Number(c) || 0, last: Number(last) || 0, start: Number(start) || 0 };
}
const enc = (state, count, last, start) => `${state}|${count}|${last}|${start}`;

// بيرجع true لو لازم نعرض الطلب للعميل دلوقتي (وبيسجّل الظهور). مفيش طلب لأي عميل بيحصل أكتر من مرة في نفس اللحظة.
export async function phonePromptDue(chatId, now = Date.now()) {
  if (!validId(chatId)) return false;
  const id = String(chatId);
  const cur = parseState(await redis(["HGET", PHS, id]));
  // أول ظهور: HSETNX ذري (يرجع 1 لطلب واحد بس حتى لو جت رسايل كتير مع بعض)
  if (!cur) return (await redis(["HSETNX", PHS, id, enc("phone_prompted", 1, now, now)])) === 1;
  if (cur.state === "phone_shared") return false;
  // سجل قديم من قبل جدول التذكير: نبدأ العدّ من دلوقتي من غير ما نظهر الطلب فجأة
  if (!cur.last) { await redis(["HSET", PHS, id, enc(cur.state, cur.count || 1, now, cur.start || now)]); return false; }
  let due = false;
  if (cur.state === "phone_prompted") due = cur.count < PROMPT_POLICY.ignoredMax && now - cur.last >= PROMPT_POLICY.ignoredEveryMs;
  else if (cur.state === "phone_skipped") due = now - cur.start <= PROMPT_POLICY.skippedWindowMs && now - cur.last >= PROMPT_POLICY.skippedEveryMs;
  if (!due) return false;
  // قفل قصير يمنع تكرار الطلب لو جت رسالتين في نفس اللحظة
  if ((await redis(["SET", `pl:${id}`, "1", "NX", "EX", 60])) !== "OK") return false;
  return (await redis(["HSET", PHS, id, enc(cur.state, cur.count + 1, now, cur.start || now)])) !== null;
}

// ضغط زرار القايمة الرئيسية: يتسجل إن الطلب اتعرض (من غير ما يلغي أي جدول موجود)
export async function claimPhonePrompt(chatId, now = Date.now()) {
  if (!validId(chatId)) return false;
  return (await redis(["HSETNX", PHS, String(chatId), enc("phone_prompted", 1, now, now)])) === 1;
}

export async function hasPhone(chatId) {
  if (!validId(chatId)) return false;
  return (await redis(["HEXISTS", PH, String(chatId)])) === 1;
}

// بيحفظ الرقم مشفّر. بيرجع true بس لو الكتابة نجحت فعلاً
export async function savePhone(from, phone) {
  if (!from || !validId(from.id)) return false;
  const id = String(from.id);
  const blob = encryptPhone(id, phone);
  if ((await redis(["HSET", PH, id, blob])) === null) return false;
  if ((await redis(["HSET", PHS, id, "phone_shared"])) === null) return false;
  await upsertInfo(from, { pt: Date.now() }).catch(() => {});
  return true;
}

// "الاستمرار بدون مشاركة": ما بيلغيش رقم محفوظ فعلاً
export async function skipPhone(from) {
  if (!from || !validId(from.id)) return false;
  const id = String(from.id);
  if (await hasPhone(id)) return true;
  const now = Date.now(), cur = parseState(await redis(["HGET", PHS, id]));
  // ضغطة "بدون مشاركة": بداية دورة التذكير كل 3 أيام (ولو كان متخطي قبل كده نحتفظ ببداية الدورة)
  const keep = cur && cur.state === "phone_skipped" && cur.start;
  const r = await redis(["HSET", PHS, id, enc("phone_skipped", keep ? cur.count : 0, now, keep ? cur.start : now)]);
  await upsertInfo(from).catch(() => {});
  return r !== null;
}

// ---------- قراءة للوحة الإدارة ----------
function stateOf(stored, hasPh) {
  if (hasPh) return "phone_shared";
  const b = baseState(stored);
  return PHONE_STATES.includes(b) && b !== "phone_shared" ? b : "phone_not_requested";
}

// بيانات مجموعة عملاء (للأسئلة): 3 أوامر Redis فقط مهما كان العدد
export async function customerMap(ids, { withPhones = false } = {}) {
  const list = [...new Set(ids.map(String).filter(validId))];
  const out = {};
  if (!list.length) return out;
  const [infos, states, phones] = await Promise.all([
    redis(["HMGET", INFO, ...list]), redis(["HMGET", PHS, ...list]), redis(["HMGET", PH, ...list]),
  ]);
  list.forEach((id, i) => {
    const info = parse(infos?.[i]) || {};
    const hasPh = !!phones?.[i];
    out[id] = {
      chatId: id, name: info.n || "", username: info.u || "", firstSeen: info.fs || null,
      phoneState: stateOf(states?.[i], hasPh), hasPhone: hasPh,
      ...(withPhones && hasPh ? { phone: decryptPhone(id, phones[i]) } : {}),
    };
  });
  return out;
}

function toObj(arr) { const o = {}; for (let i = 0; i < (arr?.length || 0); i += 2) o[arr[i]] = arr[i + 1]; return o; }

// كل العملاء المعروفين: اللي ليهم سجل + أصحاب الأسئلة (حتى لو قدامى بدون سجل بعد)
export async function listCustomers({ questions = [], filter = "all", q = "", withPhones = false } = {}) {
  const [infoA, phsA, phA] = await Promise.all([redis(["HGETALL", INFO]), redis(["HGETALL", PHS]), redis(["HGETALL", PH])]);
  const infos = toObj(infoA), states = toObj(phsA), phones = toObj(phA);
  const byId = {};
  const ensure = (id) => (byId[id] ||= { chatId: id, name: "", username: "", firstSeen: null });
  Object.keys(infos).forEach((id) => { const i = parse(infos[id]) || {}; Object.assign(ensure(id), { name: i.n || "", username: i.u || "", firstSeen: i.fs || null }); });
  Object.keys(states).concat(Object.keys(phones)).forEach(ensure);
  questions.forEach((x) => {
    if (!validId(x.chatId)) return;
    const c = ensure(String(x.chatId));
    if (!c.name && x.customerName) c.name = x.customerName;
    if (!c.username && x.username) c.username = x.username;
    if (!c.firstSeen || x.t < c.firstSeen) c.firstSeen = x.t;   // أقدم سؤال = أقدم تفاعل معروف
  });
  const needle = String(q || "").trim().toLowerCase().replace(/^@/, "");
  const needleDigits = needle.replace(/\D/g, "");
  let rows = Object.values(byId).map((c) => {
    const hasPh = !!phones[c.chatId];
    return { ...c, phoneState: stateOf(states[c.chatId], hasPh), hasPhone: hasPh };
  });
  if (filter === "shared") rows = rows.filter((c) => c.hasPhone);
  else if (filter === "notshared") rows = rows.filter((c) => !c.hasPhone);
  if (needle) {
    rows = rows.filter((c) => {
      if (c.name.toLowerCase().includes(needle) || c.username.toLowerCase().includes(needle) || c.chatId.includes(needle)) return true;
      if (withPhones && needleDigits.length >= 3 && c.hasPhone) return (decryptPhone(c.chatId, phones[c.chatId]) || "").replace(/\D/g, "").includes(needleDigits);
      return false;
    });
  }
  rows.sort((a, b) => (b.firstSeen || 0) - (a.firstSeen || 0));
  return rows;
}

export async function customerDetail(chatId, { withPhones = false } = {}) {
  const m = await customerMap([chatId], { withPhones });
  return m[String(chatId)] || null;
}

export async function phoneSharedCount() {
  return Number((await redis(["HLEN", PH])) ?? 0) || 0;
}

// عدد اللي شاركوا أرقامهم في يوم محدد (من وقت المشاركة pt المسجّل في سجل العميل؛ بدون أي رقم هاتف)
export async function phonesSharedOnDay(date) {
  const o = toObj((await redis(["HGETALL", INFO])) || []);
  let n = 0;
  for (const v of Object.values(o)) { const pt = parse(v)?.pt; if (pt && cairoDayOf(pt) === date) n++; }
  return n;
}
