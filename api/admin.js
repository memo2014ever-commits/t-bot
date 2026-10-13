// خادم لوحة التحكم: تسجيل دخول بدورين (أدمن / محرر)، وقراءة وحفظ وسجل نسخ من GitHub
// كل الأسرار في متغيرات البيئة في Vercel، ومش ظاهرة للمتصفح
import { timingSafeEqual } from "crypto";
import { getStats, resetStats, getQuestions, deleteQuestion, getPressLog } from "./stats.js";

const {
  ADMIN_USER, ADMIN_PASS,          // الأدمن: يعدّل ويحذف
  EDITOR_USER, EDITOR_PASS,        // المحرر (اختياري): يعدّل ومايحذفش
  GITHUB_TOKEN, GITHUB_REPO,
  GITHUB_FILE = "content.json", GITHUB_BRANCH = "main",
} = process.env;

const API = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`;
const GH_HEADERS = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "legan-admin",
};

function safeEq(a = "", b = "") {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && timingSafeEqual(A, B);
}

// يرجع الدور: "admin" أو "editor" أو null
function authenticate(u, p) {
  if (ADMIN_USER && safeEq(u, ADMIN_USER) && safeEq(p, ADMIN_PASS)) return "admin";
  if (EDITOR_USER && safeEq(u, EDITOR_USER) && safeEq(p, EDITOR_PASS)) return "editor";
  return null;
}

function countNodes(n) {
  return 1 + (n.items || []).reduce((a, c) => a + countNodes(c), 0);
}

function validate(node, isRoot = true, depth = 0) {
  if (depth > 4) return "الشجرة أعمق من 4 مستويات";
  if (!node || typeof node.text !== "string") return "فيه عنصر من غير نص";
  if (node.text.length > 3500) return "نص طويل جداً (الحد 3500 حرف)";
  if (!isRoot && (!node.label || typeof node.label !== "string")) return "فيه زرار من غير اسم";
  if (node.action !== undefined && node.action !== "ask") return "نوع الزرار غلط";
  if (node.keywords !== undefined && (!Array.isArray(node.keywords) || node.keywords.length > 30 ||
      node.keywords.some((k) => typeof k !== "string" || k.length > 40))) {
    return "كلمات الاستدعاء لازم تكون قايمة كلمات قصيرة (حد 30 كلمة)";
  }
  if (node.url !== undefined && node.url !== "" && !/^https:\/\/[^\s]+$/.test(node.url)) return "الرابط لازم يبدأ بـ https://";
  if (node.items !== undefined && !Array.isArray(node.items)) return "items لازم تكون قايمة";
  if ((node.items || []).length > 12) return "الحد 12 زرار في القايمة الواحدة";
  for (const child of node.items || []) {
    const err = validate(child, false, depth + 1);
    if (err) return err;
  }
  return null;
}

async function readCurrent(ref = GITHUB_BRANCH) {
  const j = await (await fetch(`${API}?ref=${ref}`, { headers: GH_HEADERS })).json();
  return { sha: j.sha, content: JSON.parse(Buffer.from(j.content, "base64").toString("utf8")) };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method" });

  const { username, password, action, content, message, ref } = req.body || {};
  const role = authenticate(username, password);
  if (!role) return res.status(401).json({ error: "اسم المستخدم أو الباسورد غلط" });

  try {
    if (action === "get") {
      const { content: data } = await readCurrent();
      return res.json({ content: data, role });
    }

    if (action === "stats") {
      return res.json(await getStats());
    }

    if (action === "questions") {
      return res.json({ questions: await getQuestions() });
    }

    if (action === "delq") {
      if (typeof ref !== "string" || ref.length > 1000) return res.status(400).json({ error: "سؤال غلط" });
      await deleteQuestion(ref);
      return res.json({ ok: true });
    }

    if (action === "presslog") {
      return res.json({ log: await getPressLog() });
    }

    if (action === "reset") {
      if (role !== "admin") return res.status(403).json({ error: "التصفير للأدمن بس" });
      await resetStats();
      return res.json({ ok: true });
    }

    if (action === "history") {
      const r = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/commits?path=${GITHUB_FILE}&sha=${GITHUB_BRANCH}&per_page=20`,
        { headers: GH_HEADERS }
      );
      const list = await r.json();
      return res.json({
        commits: list.map((c) => ({
          sha: c.sha,
          date: c.commit.author.date,
          message: c.commit.message,
        })),
      });
    }

    if (action === "version") {
      if (!/^[0-9a-f]{7,40}$/.test(ref || "")) return res.status(400).json({ error: "نسخة غلط" });
      const { content: data } = await readCurrent(ref);
      return res.json({ content: data });
    }

    if (action === "save") {
      const err = validate(content);
      if (err) return res.status(400).json({ error: err });
      if (content.medicalKeywords !== undefined) {
        if (!Array.isArray(content.medicalKeywords) || content.medicalKeywords.length > 100 ||
            content.medicalKeywords.some((w) => typeof w !== "string" || w.length > 40)) {
          return res.status(400).json({ error: "كلمات الطب لازم تكون قايمة كلمات قصيرة (حد 100 كلمة)" });
        }
      }
      if (content.questionWords !== undefined) {
        if (!Array.isArray(content.questionWords) || content.questionWords.length > 200 ||
            content.questionWords.some((w) => typeof w !== "string" || w.length > 30)) {
          return res.status(400).json({ error: "كلمات السؤال لازم تكون قايمة كلمات قصيرة (حد 200 كلمة)" });
        }
      }
      if (content.messages !== undefined) {
        if (typeof content.messages !== "object") return res.status(400).json({ error: "رسايل النظام غلط" });
        for (const v of Object.values(content.messages)) {
          if (typeof v !== "string" || v.length > 500) return res.status(400).json({ error: "رسالة نظام طويلة أو غلط (الحد 500 حرف)" });
        }
      }

      const cur = await readCurrent();
      // المحرر ما يقدرش يحذف: لو عدد الزراير قل، نرفض
      if (role === "editor" && countNodes(content) < countNodes(cur.content)) {
        return res.status(403).json({ error: "المحرر مايقدرش يحذف زراير، اطلب من الأدمن" });
      }

      const r = await fetch(API, {
        method: "PUT",
        headers: GH_HEADERS,
        body: JSON.stringify({
          message: (message || "تعديل من لوحة التحكم").slice(0, 200),
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
