const { Telegraf } = require('telegraf');

// التوكن الجديد
const bot = new Telegraf('8245297945:AAGNGcUEfe2hM_a649x-cuIXh2c2imEAJIo');

bot.start((ctx) => ctx.reply('أهلاً بك! البوت شغال بالتوكن الجديد تمام 🚀'));
bot.on('text', (ctx) => ctx.reply(`وصلتني رسالتك: ${ctx.message.text}`));

bot.launch();
console.log('Bot is running with Polling...');