const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { exec, spawn, execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIG
const BOT_TOKEN = '7746909781:AAElOmLfq_i3BKvO22am_cSGIEd80DjMRAM';
const CHANNEL_ID = '-1002493057827';
const ADMIN_IDS = ['7367349311']; // add more admin IDs if needed

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const BASE_DIR = __dirname;
const UPLOAD_BASE_DIR = path.join(BASE_DIR, 'userbot');
const USERS_FILE = path.join(BASE_DIR, 'users.json');
const BOT_STATE_FILE = path.join(BASE_DIR, 'bot_status.json');
const KEEP_FILES = ['server.js', 'package.json', 'users.json', 'node_modules', 'bot_status.json'];

// Ensure folders and files exist
if (!fs.existsSync(UPLOAD_BASE_DIR)) fs.mkdirSync(UPLOAD_BASE_DIR);
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([]));
if (!fs.existsSync(BOT_STATE_FILE)) fs.writeFileSync(BOT_STATE_FILE, JSON.stringify({}));

// Helper: Load users
function loadUsers() {
  return JSON.parse(fs.readFileSync(USERS_FILE));
}

// Helper: Save users
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users));
}

// Helper: Load bot states
function loadBotState() {
  return JSON.parse(fs.readFileSync(BOT_STATE_FILE));
}

// Helper: Save bot states
function saveBotState(state) {
  fs.writeFileSync(BOT_STATE_FILE, JSON.stringify(state));
}

// Start Express server
app.get('/', (req, res) => {
  res.send('🤖 Telegram Bot Runner is live.');
});

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});

// Handle /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  let users = loadUsers();
  if (!users.includes(chatId)) {
    users.push(chatId);
    saveUsers(users);
  }

  bot.sendMessage(chatId, '👋 Send me your `bot.js` and `package.json`. I will install and run it!');
});

// Helper: Run user bot process with auto-restart
function runUserBot(chatId) {
  const userDir = path.join(UPLOAD_BASE_DIR, chatId.toString());
  const botPath = path.join(userDir, 'bot.js');

  if (!fs.existsSync(botPath)) {
    bot.sendMessage(chatId, '❌ bot.js not found. Please upload your bot files again.');
    return;
  }

  // Check if already running
  if (runningBots.has(chatId)) {
    bot.sendMessage(chatId, '⚠️ Your bot is already running.');
    return;
  }

  const child = spawn('node', ['bot.js'], {
    cwd: userDir,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  runningBots.set(chatId, child);

  // Update bot state file
  const botStates = loadBotState();
  botStates[chatId] = true;
  saveBotState(botStates);

  bot.sendMessage(chatId, '✅ Your bot is now running!');

  child.on('exit', (code) => {
    runningBots.delete(chatId);
    const botStates = loadBotState();
    botStates[chatId] = false;
    saveBotState(botStates);

    if (code !== 0) {
      bot.sendMessage(chatId, '⚠️ Your bot crashed. Restarting...');
      runUserBot(chatId);
    } else {
      bot.sendMessage(chatId, 'ℹ️ Your bot process exited.');
    }
  });
}

// Keep track of running bots in memory
const runningBots = new Map();

// Handle uploaded files (bot.js or package.json)
bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const fileId = msg.document.file_id;
  const fileName = msg.document.file_name;

  const file = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

  // Make user directory if not exists
  const userDir = path.join(UPLOAD_BASE_DIR, chatId.toString());
  if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });

  const filePath = path.join(userDir, fileName);
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

      const files = fs.readdirSync(userDir);
      if (files.includes('bot.js') && files.includes('package.json')) {
        bot.sendMessage(chatId, '📦 Installing dependencies...');

        exec(`cd ${userDir} && npm install`, (err, stdout, stderr) => {
          if (err) {
            bot.sendMessage(chatId, `❌ Install error:\n${stderr}`);
            return;
          }

          runUserBot(chatId);
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
      const users = loadUsers();
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

// Auto-restart all running bots on startup
function autoRestartBots() {
  const botStates = loadBotState();
  Object.entries(botStates).forEach(([chatId, isRunning]) => {
    if (isRunning) {
      const userDir = path.join(UPLOAD_BASE_DIR, chatId);
      const botPath = path.join(userDir, 'bot.js');
      if (fs.existsSync(botPath)) {
        runUserBot(parseInt(chatId));
        console.log(`🔄 Auto-restarted bot for user ${chatId}`);
      }
    }
  });
}
autoRestartBots();

// Add admin-only command example (ban user)
bot.onText(/\/ban (\d+)/, (msg, match) => {
  const chatId = msg.chat.id.toString();
  if (!ADMIN_IDS.includes(chatId)) return;

  const userIdToBan = match[1];
  let bannedUsers = loadBannedUsers();
  if (!bannedUsers.includes(userIdToBan)) {
    bannedUsers.push(userIdToBan);
    saveBannedUsers(bannedUsers);
    bot.sendMessage(chatId, `User ${userIdToBan} banned.`);
  }
});

bot.onText(/\/unban (\d+)/, (msg, match) => {
  const chatId = msg.chat.id.toString();
  if (!ADMIN_IDS.includes(chatId)) return;

  const userIdToUnban = match[1];
  let bannedUsers = loadBannedUsers();
  bannedUsers = bannedUsers.filter(id => id !== userIdToUnban);
  saveBannedUsers(bannedUsers);
  bot.sendMessage(chatId, `User ${userIdToUnban} unbanned.`);
});

const BANNED_FILE = path.join(BASE_DIR, 'banned.json');
function loadBannedUsers() {
  if (!fs.existsSync(BANNED_FILE)) fs.writeFileSync(BANNED_FILE, JSON.stringify([]));
  return JSON.parse(fs.readFileSync(BANNED_FILE));
}
function saveBannedUsers(users) {
  fs.writeFileSync(BANNED_FILE, JSON.stringify(users));
}

// Prevent banned users from uploading files
bot.on('document', async (msg) => {
  const chatId = msg.chat.id.toString();
  const bannedUsers = loadBannedUsers();
  if (bannedUsers.includes(chatId)) {
    bot.sendMessage(chatId, '🚫 You are banned from uploading files.');
    return;
  }
  // Existing upload code runs here...
  // (You can move your upload handling logic to a separate function and call it here.)
});

// You may want to merge both 'document' handlers into one,
// so banning check happens before processing uploads.
