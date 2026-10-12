// خادم لوحة التحكم: بيتحقق من اليوزر والباسورد، وبيقرا ويحفظ content.json على GitHub
// كل الأسرار هنا في متغيرات البيئة في Vercel، ومش ظاهرة للمتصفح خالص
const {
  ADMIN_USER, ADMIN_PASS,
  GITHUB_TOKEN, GITHUB_REPO,
  GITHUB_FILE = "content.json", GITHUB_BRANCH = "main",
} = process.env;

const API = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`;
const GH_HEADERS = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "legan-admin",
};

// مقارنة آمنة للباسورد
import { timingSafeEqual } from "crypto";
function safeEq(a = "", b = "") {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && timingSafeEqual(A, B);
}

// فحص المحتوى قبل الحفظ: عشان ما يتحفظش شجرة بايظة تكسر البوت
function validate(node, isRoot = true, depth = 0) {
  if (depth > 4) return "الشجرة أعمق من 4 مستويات";
  if (!node || typeof node.text !== "string") return "فيه عنصر من غير نص";
  if (node.text.length > 3500) return "نص طويل جداً (الحد 3500 حرف)";
  if (!isRoot && (!node.label || typeof node.label !== "string")) return "فيه زرار من غير اسم";
  if (node.items !== undefined && !Array.isArray(node.items)) return "items لازم تكون قايمة";
  if ((node.items || []).length > 12) return "الحد 12 زرار في القايمة الواحدة";
  for (const child of node.items || []) {
    const err = validate(child, false, depth + 1);
    if (err) return err;
  }
  return null;
}

import { getStats } from "./stats.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method" });

  const { username, password, action, content } = req.body || {};
  if (!safeEq(username, ADMIN_USER) || !safeEq(password, ADMIN_PASS)) {
    return res.status(401).json({ error: "اسم المستخدم أو الباسورد غلط" });
  }

  try {
    if (action === "stats") {
      return res.json(await getStats());
    }

    if (action === "get") {
      const r = await fetch(`${API}?ref=${GITHUB_BRANCH}`, { headers: GH_HEADERS });
      const j = await r.json();
      const data = JSON.parse(Buffer.from(j.content, "base64").toString("utf8"));
      return res.json({ content: data });
    }

    if (action === "save") {
      const err = validate(content);
      if (err) return res.status(400).json({ error: err });

      // نجيب الـ sha الحالي عشان GitHub يقبل التعديل
      const cur = await (await fetch(`${API}?ref=${GITHUB_BRANCH}`, { headers: GH_HEADERS })).json();
      const r = await fetch(API, {
        method: "PUT",
        headers: GH_HEADERS,
        body: JSON.stringify({
          message: "تحديث محتوى البوت من لوحة التحكم",
          content: Buffer.from(JSON.stringify(content, null, 2)).toString("base64"),
          sha: cur.sha,
          branch: GITHUB_BRANCH,
        }),
      });
      if (!r.ok) return res.status(500).json({ error: "فشل الحفظ على GitHub" });
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: "action غلط" });
  } catch {
    return res.status(500).json({ error: "حصل خطأ في السيرفر" });
  }
}
