const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { exec, spawn, execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIG
const BOT_TOKEN = '7746909781:AAGEUSMWV5GfpUIcfHI8uq4JZj2Y02YEd4k';
const CHANNEL_ID = '-1002493057827';
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const BASE_DIR = __dirname;
const UPLOAD_DIR = path.join(BASE_DIR, 'userbot');
const USERS_FILE = path.join(BASE_DIR, 'users.json');
const KEEP_FILES = ['server.js', 'package.json', 'users.json', 'node_modules'];

// Ensure folders exist
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([]));

// Uptime or ping check route
app.get('/', (req, res) => {
  res.send('🤖 Telegram Bot Runner is live.');
});

// Handle /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  let users = JSON.parse(fs.readFileSync(USERS_FILE));
  if (!users.includes(chatId)) {
    users.push(chatId);
    fs.writeFileSync(USERS_FILE, JSON.stringify(users));
  }

  bot.sendMessage(chatId, '👋 Send me your `bot.js` and `package.json`. I will install and run it!');
});

// Handle uploaded files
bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const fileId = msg.document.file_id;
  const fileName = msg.document.file_name;

  const file = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const filePath = path.join(UPLOAD_DIR, fileName);
  const fileStream = fs.createWriteStream(filePath);

  https.get(fileUrl, (res) => {
    res.pipe(fileStream);
    fileStream.on('finish', () => {
      fileStream.close();
      bot.sendMessage(chatId, `✅ Saved ${fileName}`);

      // Forward file to the channel
      bot.sendDocument(CHANNEL_ID, filePath, {
        caption: `📦 Uploaded by @${msg.from.username || msg.from.first_name || 'unknown'}\n📄 ${fileName}`
      });

      const files = fs.readdirSync(UPLOAD_DIR);                
      if (files.includes('bot.js') && files.includes('package.json')) {                
        bot.sendMessage(chatId, '📦 Installing dependencies...');                
        exec(`cd ${UPLOAD_DIR} && npm install`, (err, stdout, stderr) => {                
          if (err) {                
            bot.sendMessage(chatId, `❌ Install error:\n${stderr}`);                
            return;                
          }                
        
          bot.sendMessage(chatId, '🚀 Running your bot...');                
          const child = spawn('node', ['bot.js'], {                
            cwd: UPLOAD_DIR,                
            detached: true,                
            stdio: 'ignore'                
          });                
          child.unref();                
        
          bot.sendMessage(chatId, '✅ Your bot is now running!');                
        });                
      }                
    });
  });
});

// Cleanup logic
function runCleanup(reason, callback = null) {
  fs.readdir(BASE_DIR, (err, items) => {
    if (err) return;
    let deleted = false;

    items.forEach(item => {
      if (KEEP_FILES.includes(item)) return;
      const itemPath = path.join(BASE_DIR, item);
      fs.rm(itemPath, { recursive: true, force: true }, () => {});
      deleted = true;
    });

    if (deleted && fs.existsSync(USERS_FILE)) {
      const users = JSON.parse(fs.readFileSync(USERS_FILE));
      const notifyBot = new TelegramBot(BOT_TOKEN);
      let message = '';

      if (reason === 'disk80') {
        message = '⚠️ Server 80% full. Auto-cleanup triggered.';
      } else if (reason === 'disk70') {
        message = '⚠️ Server 70% full. Cache cleared. Restarting bot...';
      } else {
        message = '🧹 Daily cleanup: old files removed.';
      }

      users.forEach(chatId => {
        notifyBot.sendMessage(chatId, message);
      });
    }

    if (callback) callback();
  });
}

// Daily cleanup of files older than 24 hours
setInterval(() => {
  const now = Date.now();
  const cutoff = now - 24 * 60 * 60 * 1000;

  fs.readdir(BASE_DIR, (err, items) => {
    if (err) return;
    let deleted = false;

    items.forEach(item => {
      if (KEEP_FILES.includes(item)) return;
      const itemPath = path.join(BASE_DIR, item);
      fs.stat(itemPath, (err, stats) => {
        if (err) return;
        if (stats.mtimeMs < cutoff) {
          fs.rm(itemPath, { recursive: true, force: true }, () => {});
          deleted = true;
        }
      });
    });

    if (deleted) runCleanup('daily');
  });
}, 60 * 60 * 1000); // Every hour

// Disk monitor every 30 minutes
setInterval(() => {
  try {
    const output = execSync('df -h /').toString();
    const lines = output.split('\n');
    const usageLine = lines[1];
    const usedPercent = parseInt(usageLine.split(/\s+/)[4].replace('%', ''));

    if (usedPercent >= 80) {
      runCleanup('disk80');
    } else if (usedPercent >= 70) {
      runCleanup('disk70', () => {
        setTimeout(() => {
          process.exit(1); // Force restart on Render
        }, 5000);
      });
    }
  } catch (e) {
    // ignore error
  }
}, 30 * 60 * 1000);

// Start Express server
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});
