// شرح سبب الخطأ للمستخدم (بدل "حصل خطأ في السيرفر") + نص آمن للتسجيل في Vercel Logs.
// - مفيش أسرار ولا بيانات عملاء بتتسجّل أو بتتعرض (بنشيل التوكنات والمفاتيح من أي نص).
import { getLastRedisError } from "./stats.js";

// بيشيل أي سر معروف (من متغيرات البيئة) ونمط توكن تيليجرام و Bearer من أي نص
export function scrub(text) {
  let t = String(text ?? "");
  for (const k of ["BOT_TOKEN", "GITHUB_TOKEN", "KV_REST_API_TOKEN", "ADMIN_PASS", "EDITOR_PASS", "PHONE_ENC_KEY", "IMGBB_API_KEY"]) {
    const v = process.env[k];
    if (v && v.length >= 6) t = t.split(v).join("***");
  }
  return t.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot***").replace(/Bearer\s+\S+/gi, "Bearer ***");
}

// e.source: "telegram" | "github" | "imgbb"  (بيتحط في أماكن النداء الخارجي في admin.js)
export function explainError(e, action = "?") {
  const raw = scrub(e?.message || e);
  const src = e?.source;
  let status = 500;
  let message = "حصل خطأ غير متوقع في السيرفر. السبب اتسجّل في Vercel Logs (Runtime Logs).";

  if (src === "telegram") {
    status = 502;
    const d = raw.toLowerCase();
    if (e.network) message = "تعذّر الاتصال بتيليجرام من السيرفر. جرّب تاني بعد شوية.";
    else if (d.includes("blocked by the user")) message = "العميل حظر البوت، فمقدرناش نوصّل له الرد.";
    else if (d.includes("user is deactivated")) message = "حساب العميل على تيليجرام معطّل أو محذوف.";
    else if (d.includes("chat not found")) message = "تيليجرام مش لاقي المحادثة دي (العميل غالباً مسح المحادثة أو الحساب).";
    else if (d.includes("initiate conversation")) message = "العميل لازم يبدأ المحادثة مع البوت الأول.";
    else if (d.includes("caption is too long")) message = "نص الإجابة طويل جداً مع الصورة (الحد 1024 حرف). قصّر النص.";
    else if (d.includes("message is too long")) message = "نص الإجابة طويل جداً (الحد 4096 حرف). قصّره.";
    else if (d.includes("too many requests")) message = `تيليجرام طلب الانتظار شوية بسبب كتر الرسايل${e.retryAfter ? ` (${e.retryAfter} ثانية)` : ""}. جرّب تاني.`;
    else if (d.includes("wrong file identifier") || d.includes("http url") || d.includes("failed to get")) message = "رابط الصورة غير صالح أو تيليجرام مقدرش يفتحه. ارفع الصورة تاني.";
    else if (e.status === 401 || d.includes("unauthorized")) message = "BOT_TOKEN غير صالح أو اتلغى. راجعه في إعدادات Vercel.";
    else message = `تيليجرام رفض الإرسال: ${raw}`;
  } else if (src === "github") {
    status = 502;
    if (e.network) message = "تعذّر الاتصال بـ GitHub من السيرفر. جرّب تاني بعد شوية.";
    else if (e.status === 401) message = "GITHUB_TOKEN غير صالح أو منتهي. جدّده في GitHub وحدّث المتغير في Vercel.";
    else if (e.status === 403) message = "GitHub رفض الطلب: صلاحية التوكن (لازم Contents: Read and write) أو تجاوز حد الطلبات.";
    else if (e.status === 404) message = "مش لاقي ملف المحتوى في GitHub. راجع GITHUB_REPO وGITHUB_FILE وGITHUB_BRANCH.";
    else if (e.status === 409) message = "حد تاني عدّل المحتوى في نفس الوقت. حدّث الصفحة وحاول تاني.";
    else message = `GitHub رجّع خطأ (${e.status || "?"}): ${raw}`;
  } else if (src === "imgbb") {
    status = 502;
    message = e.network ? "تعذّر الاتصال بخدمة رفع الصور (ImgBB). جرّب تاني." : `خدمة رفع الصور رفضت الصورة: ${raw}`;
  } else {
    // خطأ داخلي: لو Redis رجّع خطأ من لحظات، غالباً هو السبب
    const rr = getLastRedisError();
    if (rr && Date.now() - rr.t < 15000) {
      const m = rr.msg.toLowerCase();
      if (/limit|quota|exceed/.test(m)) message = "قاعدة البيانات (Upstash Redis) رفضت الطلب لتجاوز حد الاستخدام. راجع الخطة في حسابك على Upstash.";
      else if (/auth|token|wrongpass|noauth/.test(m)) message = "بيانات الدخول لقاعدة البيانات غلط (KV_REST_API_TOKEN). راجعها في Vercel.";
      else message = `قاعدة البيانات (Redis) رجّعت خطأ: ${rr.msg}`;
    }
  }
  const stack = e?.stack ? scrub(String(e.stack).split("\n").slice(1, 3).join(" | ")) : "";
  const log = `${action} | ${src || "internal"} | ${e?.status || ""} | ${raw.slice(0, 300)}${!src && stack ? " | " + stack.slice(0, 250) : ""}`;
  return { status, message, log, code: src || "internal" };
}
