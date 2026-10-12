# البرومت (انسخه كله في VS Code على Copilot أو أي مساعد AI)

أنا عايز أعمل بوت تلجرام للمعلومات العامة، مكتوب بـ Node.js و grammY، متنشر على Vercel، والمحتوى بتاعه بيتعدل من لوحة تحكم محمية بيوزر وباسورد.

## الملفات المطلوبة بالظبط
1. package.json: type module، dependencies: grammy ^1.30.0
2. api/webhook.js: بوت grammY، يقرأ BOT_TOKEN و CONTENT_URL من process.env، يقرأ content.json مع كاش دقيقة، أمر /start، callback_data بصيغة "n:<path>"، getNode و render، زرار رجوع، editMessageText بدل رسايل جديدة، export default webhookCallback(bot, "https")
3. api/admin.js: POST بس، يتحقق من ADMIN_USER و ADMIN_PASS بمقارنة آمنة (timingSafeEqual)، action "get" يقرأ content.json من GitHub API، action "save" يتحقق من الشجرة (validate: عمق 4، 12 زرار، 3500 حرف) ويكتب على GitHub بالـ sha الحالي، كل الأسرار من process.env
4. public/index.html: صفحة RTL عربي، شاشة دخول (يوزر وباسورد)، بعد الدخول شجرة تحرير: كل عقدة فيها اسم الزرار و textarea للنص و"➕ زرار جوه" و"🗑 حذف" (إلا الجذر)، وزرار "حفظ وتحديث البوت" يبعت للـ API. الباسورد في متغير JS بس، مش localStorage
5. content.json: نموذج فيه القايمة الرئيسية (تعليمات الحجز، الأسئلة الشائعة بسؤالين، معلومات عامة، عناوين اللجان بمحافظتين) والنصوص المؤقتة بين [ ]
6. .env.example، .gitignore (node_modules, .env, .vercel)
7. README.md بخطوات بسيطة للمبتدئ

## قواعد
- الكود بالعربي في التعليقات، والأسماء بالإنجليزي
- ما تحطش أي Token أو باسورد أو رابط حقيقي في الكود
- اعمل كل ملف كامل بدون "..." أو اختصار
- في الآخر اعرض قائمة الملفات اللي اتعملت
