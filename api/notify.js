// تنبيهات الموظفين على تيليجرام: سؤال جديد / متابعة جديدة.
// - الربط بكود مؤقت بيطلع من اللوحة (ماحدش يقدر يربط نفسه من غير الأدمن).
// - الإعدادات (تشغيل، حد التنبيهات في الدقيقة، عدد حروف النص...) محفوظة في Redis وبتتغير من اللوحة من غير نشر.
// - التنبيه مش بيعطّل رد العميل أبداً: أي فشل بيتسجّل بس.
import { randomInt } from "crypto";
import { redis } from "./stats.js";
import { explainError } from "./errors.js";

const CFG = "cfg:notify";          // hash: الإعدادات
const CHATS = "ntf:chats";         // hash: chatId -> JSON { label, type, linkedAt, lastError?, lastErrorAt? }
const LAST = "ntf:last";           // آخر إرسال: JSON { t, ok, sent, failed, kind }
export const MAX_NOTIFY_CHATS = 3;
export const LINK_CODE_TTL = 600;  // ثواني
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // من غير حروف بتتلخبط (O/0 ، I/1/L)

export const NOTIFY_DEFAULTS = { enabled: false, onQuestion: true, onFollowup: true, showName: true, previewChars: 80, maxPerMinute: 10, panelUrl: "" };

const esc = (t) => String(t ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
function toObj(arr) { const o = {}; for (let i = 0; i < (arr?.length || 0); i += 2) o[arr[i]] = arr[i + 1]; return o; }
const bool = (v, d) => (v === undefined || v === null ? d : v === "1" || v === true);

// ---------- الإعدادات ----------
export async function getNotifyConfig() {
  const o = toObj((await redis(["HGETALL", CFG])) || []);
  const n = (v, d, lo, hi) => { const x = parseInt(v, 10); return Number.isInteger(x) && x >= lo && x <= hi ? x : d; };
  return {
    enabled: bool(o.enabled, NOTIFY_DEFAULTS.enabled), onQuestion: bool(o.onQuestion, NOTIFY_DEFAULTS.onQuestion),
    onFollowup: bool(o.onFollowup, NOTIFY_DEFAULTS.onFollowup), showName: bool(o.showName, NOTIFY_DEFAULTS.showName),
    previewChars: n(o.previewChars, NOTIFY_DEFAULTS.previewChars, 0, 300), maxPerMinute: n(o.maxPerMinute, NOTIFY_DEFAULTS.maxPerMinute, 1, 30),
    panelUrl: /^https:\/\/\S{1,200}$/.test(o.panelUrl || "") ? o.panelUrl : "",
  };
}

// patch: أي مجموعة من الحقول. بيرجّع الإعدادات الجديدة أو { error }
export async function setNotifyConfig(patch) {
  const args = ["HSET", CFG];
  for (const k of ["enabled", "onQuestion", "onFollowup", "showName"]) {
    if (patch[k] === undefined) continue;
    if (typeof patch[k] !== "boolean") return { error: "القيمة غير صحيحة" };
    args.push(k, patch[k] ? "1" : "0");
  }
  if (patch.previewChars !== undefined) {
    if (!Number.isInteger(patch.previewChars) || patch.previewChars < 0 || patch.previewChars > 300) return { error: "عدد الحروف من 0 إلى 300" };
    args.push("previewChars", String(patch.previewChars));
  }
  if (patch.maxPerMinute !== undefined) {
    if (!Number.isInteger(patch.maxPerMinute) || patch.maxPerMinute < 1 || patch.maxPerMinute > 30) return { error: "الحد الأقصى في الدقيقة من 1 إلى 30" };
    args.push("maxPerMinute", String(patch.maxPerMinute));
  }
  if (patch.panelUrl !== undefined) {
    if (typeof patch.panelUrl !== "string" || (patch.panelUrl && !/^https:\/\/\S{1,200}$/.test(patch.panelUrl))) return { error: "رابط اللوحة لازم يبدأ بـ https://" };
    args.push("panelUrl", patch.panelUrl);
  }
  if (args.length === 2) return { error: "مفيش حاجة للتعديل" };
  if ((await redis(args)) === null) return { error: "فشل حفظ الإعدادات، لم يتم تغيير أي شيء" };
  return { ok: true, config: await getNotifyConfig() };
}

// ---------- المحادثات المربوطة ----------
export async function listNotifyChats() {
  const o = toObj((await redis(["HGETALL", CHATS])) || []);
  return Object.entries(o).map(([chatId, v]) => ({ chatId, ...(parse(v) || {}) })).sort((a, b) => (a.linkedAt || 0) - (b.linkedAt || 0));
}
export async function unlinkNotifyChat(chatId) {
  return (await redis(["HDEL", CHATS, String(chatId)])) === 1;
}
export async function getNotifyLast() { return parse(await redis(["GET", LAST])); }

// ---------- كود الربط (بيطلع من اللوحة بس) ----------
export async function createLinkCode() {
  if ((await listNotifyChats()).length >= MAX_NOTIFY_CHATS) return { error: `وصلت للحد الأقصى (${MAX_NOTIFY_CHATS} محادثات). افصل محادثة الأول.` };
  const gen = Number(await redis(["INCR", "ntf:codegen"]));
  if (gen === 1) await redis(["EXPIRE", "ntf:codegen", LINK_CODE_TTL]);
  if (gen > 10) return { error: "طلبات كتير للكود. استنى شوية وحاول تاني." };
  for (let i = 0; i < 5; i++) {
    const code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    if ((await redis(["SET", `ntf:code:${code}`, "1", "NX", "EX", LINK_CODE_TTL])) === "OK") return { ok: true, code, expiresIn: LINK_CODE_TTL };
  }
  return { error: "تعذّر إنشاء الكود، حاول تاني." };
}

// بيتنادى من أمر /notify في البوت. chat = { id, type, label }
export async function consumeLinkCode(raw, chat) {
  const tryKey = `ntf:try:${chat.id}`;
  const n = Number(await redis(["INCR", tryKey]));
  if (n === 1) await redis(["EXPIRE", tryKey, LINK_CODE_TTL]);
  if (n > 5) return { error: "many" };               // حماية من التخمين
  const code = String(raw || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return { error: "bad" };
  if (!(await redis(["GET", `ntf:code:${code}`]))) return { error: "bad" };
  const chats = await listNotifyChats();
  if (chats.some((c) => c.chatId === String(chat.id))) { await redis(["DEL", `ntf:code:${code}`]); return { ok: true, already: true }; }
  if (chats.length >= MAX_NOTIFY_CHATS) return { error: "full" };
  if ((await redis(["DEL", `ntf:code:${code}`])) !== 1) return { error: "bad" };   // الكود بيتستهلك مرة واحدة
  const r = await redis(["HSET", CHATS, String(chat.id), JSON.stringify({ label: String(chat.label || "").slice(0, 80), type: chat.type, linkedAt: Date.now() })]);
  return r === null ? { error: "save" } : { ok: true };
}

// ---------- الإرسال ----------
function tgError(status, description, retryAfter) { return Object.assign(new Error(description), { source: "telegram", status, retryAfter }); }
async function sendHtml(chatId, text, markup) {
  let r;
  try {
    r = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) }),
    });
  } catch (e) { throw Object.assign(new Error(e?.message || "network"), { source: "telegram", network: true }); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw tgError(r.status, j.description || "فشل الإرسال", j.parameters?.retry_after);
}

export function buildText(ev, cfg) {
  const title = ev.kind === "followup" ? `📩 <b>متابعة جديدة</b>${ev.n ? ` (رقم ${esc(ev.n)})` : ""}` : "🆕 <b>سؤال جديد</b>";
  const name = cfg.showName && ev.name ? ` من <b>${esc(ev.name)}</b>` : "";
  let preview = "";
  if (cfg.previewChars > 0 && ev.text) {
    const flat = String(ev.text).replace(/\s+/g, " ").trim();
    const chars = Array.from(flat);
    preview = `\n«${esc(chars.slice(0, cfg.previewChars).join(""))}${chars.length > cfg.previewChars ? "…" : ""}»`;
  }
  return `${title}${name}${preview}`;
}
const markupFor = (cfg) => (cfg.panelUrl ? { inline_keyboard: [[{ text: "فتح اللوحة", url: cfg.panelUrl }]] } : undefined);

// حد التنبيهات في الدقيقة. send = تنبيه عادي، overflow = رسالة "كتير" مرة واحدة، skip = تجاهل
async function rateGate(max, now) {
  const key = `ntf:rl:${Math.floor(now / 60000)}`;
  const c = Number(await redis(["INCR", key]));
  if (!Number.isFinite(c)) return "send";
  if (c === 1) await redis(["EXPIRE", key, 120]);
  return c <= max ? "send" : c === max + 1 ? "overflow" : "skip";
}

// بيرسل لكل المحادثات المربوطة، وبيحدّث حالة الخطأ لكل محادثة. بيرجّع { sent, failed }
async function deliver(chats, text, markup) {
  const results = await Promise.allSettled(chats.map((c) => sendHtml(c.chatId, text, markup)));
  let sent = 0, failed = 0;
  const per = [];
  for (let i = 0; i < chats.length; i++) {
    const c = chats[i], r = results[i];
    if (r.status === "fulfilled") {
      sent++; per.push({ chatId: c.chatId, label: c.label, ok: true });
      if (c.lastError) { const { lastError, lastErrorAt, ...rest } = c; delete rest.chatId; await redis(["HSET", CHATS, c.chatId, JSON.stringify(rest)]).catch(() => {}); }
    } else {
      failed++;
      const msg = explainError(r.reason, "notify").message;
      per.push({ chatId: c.chatId, label: c.label, ok: false, error: msg });
      if (c.lastError !== msg) { const { chatId, ...rest } = c; await redis(["HSET", CHATS, c.chatId, JSON.stringify({ ...rest, lastError: msg, lastErrorAt: Date.now() })]).catch(() => {}); }
    }
  }
  return { sent, failed, per };
}

// ev = { kind: "question" | "followup", name, text, n }
export async function notifyStaff(ev, now = Date.now()) {
  const cfg = await getNotifyConfig();
  if (!cfg.enabled) return { skipped: "off" };
  if ((ev.kind === "followup" && !cfg.onFollowup) || (ev.kind !== "followup" && !cfg.onQuestion)) return { skipped: "type" };
  const chats = await listNotifyChats();
  if (!chats.length) return { skipped: "no-chats" };
  const gate = await rateGate(cfg.maxPerMinute, now);
  if (gate === "skip") return { skipped: "rate" };
  const text = gate === "overflow" ? "⚠️ <b>وصلت أسئلة ومتابعات كتير خلال دقيقة</b>\nمش هنبعت كل واحدة لوحدها، افتح اللوحة لمتابعة الباقي." : buildText(ev, cfg);
  const out = await deliver(chats, text, markupFor(cfg));
  await redis(["SET", LAST, JSON.stringify({ t: now, ok: out.failed === 0, sent: out.sent, failed: out.failed, kind: gate === "overflow" ? "overflow" : ev.kind })]).catch(() => {});
  return { sent: out.sent, failed: out.failed, gate };
}

// للبوت: مش بيرمي خطأ أبداً، وبيستنى 4 ثواني بالكتير علشان رد العميل ما يتأخرش
export async function notifyStaffSafe(ev) {
  let timer;
  try {
    await Promise.race([notifyStaff(ev), new Promise((res) => { timer = setTimeout(res, 4000); })]);
  } catch (e) { console.error("[notify]", String(e?.message || e).replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot***").slice(0, 200)); }
  finally { clearTimeout(timer); }
}

// زرار "تنبيه تجريبي" في اللوحة: بيبعت لكل المحادثات حتى لو التنبيهات متوقفة
export async function sendNotifyTest() {
  const cfg = await getNotifyConfig();
  const chats = await listNotifyChats();
  if (!chats.length) return { error: "مفيش محادثات مربوطة. اربط محادثة الأول." };
  const out = await deliver(chats, "✅ <b>تنبيه تجريبي</b>\nالتنبيهات شغّالة على المحادثة دي.", markupFor(cfg));
  await redis(["SET", LAST, JSON.stringify({ t: Date.now(), ok: out.failed === 0, sent: out.sent, failed: out.failed, kind: "test" })]).catch(() => {});
  return { ok: true, ...out };
}

let _botName = null;
export async function botUsername() {
  if (_botName) return _botName;
  try {
    const j = await (await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/getMe`)).json();
    if (j?.ok && j.result?.username) _botName = j.result.username;
  } catch {}
  return _botName;
}
