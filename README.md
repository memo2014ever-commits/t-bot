# بوت معلومات اللجان الطبية + لوحة تحكم

## أولاً: اللي محتاجه (مرة واحدة)
1. حساب تلجرام.
2. حساب GitHub (github.com).
3. حساب Vercel (vercel.com) وسجّل بحساب GitHub.

---

## ثانياً: إنشاء البوت
1. في تلجرام ابعت `/newbot` لـ @BotFather.
2. اختار اسم، وusername جديد ينتهي بـ `bot`.
3. احفظ الـ **Token** اللي هيديهولك.

---

## ثالثاً: رفع المشروع على GitHub
1. على GitHub: **New repository** ← اسمه `legan-bot` ← **Public** ← Create.
   > لازم يكون Public، عشان البوت يقدر يقرا `content.json` من الرابط المباشر. مفيش أسرار في الريبو (التوكنات والباسورد في Vercel بس).
2. ارفع كل ملفات المشروع (اسحب الملفات للصفحة) ← **Commit changes**.


---

## رابعاً: التوكن بتاع GitHub (عشان لوحة التحكم تحفظ)
1. GitHub ← Settings ← Developer settings ← Personal access tokens ← **Fine-grained tokens** ← Generate new token.
2. Repository access: **Only select repositories** ← اختار `legan-bot`.
3. Permissions ← Repository permissions ← **Contents: Read and write**.
4. انسخ التوكن (هيتعرض مرة واحدة بس).

---

## خامساً: الرفع على Vercel
1. vercel.com ← **Add New** ← **Project** ← اختار `legan-bot` ← **Import**.
2. قبل Deploy، افتح **Environment Variables** وضيف الاتنين عشرة دول:

| الاسم | القيمة |
|---|---|
| `BOT_TOKEN` | توكن البوت من BotFather |
| `CONTENT_URL` | `https://raw.githubusercontent.com/اسمك/legan-bot/main/content.json` |
| `ADMIN_USER` | اسم المستخدم اللي انت عايزه للوحة |
| `ADMIN_PASS` | باسورد طويل وقوي |
| `GITHUB_TOKEN` | توكن GitHub اللي عملته في الخطوة الرابعة |
| `GITHUB_REPO` | `اسمك/legan-bot` |
| `GITHUB_FILE` | `content.json` |
| `GITHUB_BRANCH` | `main` |

3. اضغط **Deploy**. هياخد دقيقة، وهيديك رابط زي `https://legan-bot.vercel.app`.

---

## سادساً: ربط تلجرام بالبوت
افتح المتصفح على الرابط ده (غيّر القيم):
```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://legan-bot.vercel.app/api/webhook
```
لازم يظهر `"ok":true`.

---

## سابعاً: تجربة البوت
ادخل البوت في تلجرام وابعت `/start`. القايمة لازم تظهر.

---

## ثامناً: لوحة التحكم
1. افتح `https://legan-bot.vercel.app` من أي موبايل أو كمبيوتر.
2. ادخل باسم المستخدم والباسورد اللي حطيتهم في Vercel.
3. عدّل النصوص، وضيف زراير جوه زراير، أو امسح.
4. اضغط **💾 حفظ وتحديث البوت**.
5. بعد دقيقة تقريباً جرّب `/start` في البوت.

---

## ملاحظات أمان مهمة
- الباسورد والتوكنات **في Vercel بس**، مش في الكود ولا في الصفحة.
- لو الباسورد اتسرب، غيّره من Vercel وعمل Redeploy.
- لو التوكن بتاع GitHub اتسرب، امسحه من GitHub ← Settings ← Tokens واعمل واحد جديد.
- لو التوكن بتاع البوت اتسرب، ابعت `/revoke` لـ BotFather.
- ما تحطش أي بيانات مرضى في المحتوى. ده للمعلومات العامة بس.
- النصوص اللي بين `[ ]` لازم تتملى بالمعلومة الرسمية قبل النشر.

---

## لو حاجة ما اشتغلتش
- **البوت مش بيرد:** افتح `https://api.telegram.org/bot<TOKEN>/getWebhookInfo` وشوف الخطأ. وتأكد إن `BOT_TOKEN` صح، وعمل Redeploy بعد أي تعديل في Environment Variables.
- **الدخول على اللوحة فشل:** اتأكد من `ADMIN_USER` و`ADMIN_PASS` في Vercel، وإنك عملت Redeploy.
- **الحفظ فشل:** اتأكد من `GITHUB_TOKEN` (صلاحية Contents: Read and write) و`GITHUB_REPO` بالشكل `اسمك/legan-bot`.
- **التعديل مش ظاهر في البوت:** GitHub بيتأخر شوية في تحديث الملف الخام، استنى 3-5 دقايق وجرّب تاني.
