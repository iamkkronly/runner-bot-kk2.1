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
// Your Telegram user ID for admin commands
const ADMIN_IDS = [7367349311];
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const BASE_DIR = __dirname;
const UPLOAD_DIR = path.join(BASE_DIR, 'userbot');
const USERS_FILE = path.join(BASE_DIR, 'users.json');
const KEEP_FILES = ['server.js', 'package.json', 'users.json', 'node_modules'];

// In-memory running bot child process reference
let runningBotProcess = null;

// Ensure folders exist
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([]));

// Helper: Check if user is admin
function isAdmin(chatId) {
  return ADMIN_IDS.includes(chatId);
}

// Helper: Load users
function loadUsers() {
  return JSON.parse(fs.readFileSync(USERS_FILE));
}

// Helper: Save users
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users));
}

// Express route for uptime check
app.get('/', (req, res) => {
  res.send('🤖 Telegram Bot Runner is live.');
});

// --- Command Handlers ---

// /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  let users = loadUsers();
  if (!users.includes(chatId)) {
    users.push(chatId);
    saveUsers(users);
  }
  bot.sendMessage(chatId, `👋 Welcome! Send me your \`bot.js\` and \`package.json\` to upload and run your Telegram bot.\n\nType /help for all commands.`);
});

// /help command
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  let helpMessage = `
🤖 *Available Commands:*

*Project Control:*
/start - Start interaction
/help - Show this help message
/status - Show bot running status
/restart - Restart your bot
/stop - Stop your bot
/run - Run your bot manually
/clear - Clear your uploaded files

*File Management:*
/upload - How to upload bot.js and package.json
/myfiles - List your uploaded files
/download <filename> - Download your file
/delete <filename> - Delete a file
/rename <old> <new> - Rename a file

*Dev Tools:*
/edit <filename> - Edit a file (inline)
/preview <filename> - Preview file content
/logs - Show recent logs
/logs errors - Show error logs
/console - Start a live console session

*Versioning:*
/saveversion - Save current version
/versions - List saved versions
/restore <version> - Restore version
/diff <v1> <v2> - Show diff between versions

*Dependencies:*
/install <package> - Install NPM package
/uninstall <package> - Uninstall package
/npm - List installed packages
/fixdeps - Fix missing dependencies

*Testing:*
/test <event> - Simulate Telegram event
/echo <text> - Echo text
/benchmark - Run performance test

*User & Env:*
/profile - Show your profile info
/setname <name> - Set your display name
/setenv <key=value> - Set env var
/env - List env vars
/delenv <key> - Delete env var

*Monitoring:*
/usage - Show resource usage
/uptime - Bot uptime
/activity - Recent activity
/report - Download usage report

*Maintenance:*
/cleanup - Trigger file cleanup
/reset - Reset your workspace
/autodelete on|off - Toggle auto file deletion
/healthcheck - Check server health

*Admin-only commands (admins only):*
/users - List all users
/stopall - Stop all bots
/ban <userId> - Ban a user
/unban <userId> - Unban user
/broadcast <msg> - Broadcast message
/diskstatus - Disk usage
/rebootserver - Restart server

*Extra:*
/whoami - Show your info
/serverip - Show server IP
/joke - Tell a joke
/feedback - Send feedback to admin

---

*Use /help <command> for details on a specific command.*
  `;
  bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// Handle commands with parameters (like /download <filename>)
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';

  // Ignore commands without parameters here
  if (!text.startsWith('/')) return;

  // Extract command and params
  const split = text.split(' ');
  const command = split[0].toLowerCase();
  const args = split.slice(1);

  // === Project Control Commands ===
  if (command === '/status') {
    const status = runningBotProcess ? '🟢 Your bot is running.' : '🔴 Your bot is not running.';
    bot.sendMessage(chatId, status);
    return;
  }

  if (command === '/restart') {
    if (runningBotProcess) {
      runningBotProcess.kill();
      runningBotProcess = null;
    }
    runUserBot(chatId);
    bot.sendMessage(chatId, '♻️ Restarted your bot.');
    return;
  }

  if (command === '/stop') {
    if (runningBotProcess) {
      runningBotProcess.kill();
      runningBotProcess = null;
      bot.sendMessage(chatId, '🛑 Your bot has been stopped.');
    } else {
      bot.sendMessage(chatId, 'ℹ️ No running bot to stop.');
    }
    return;
  }

  if (command === '/run') {
    if (runningBotProcess) {
      bot.sendMessage(chatId, '⚠️ Your bot is already running.');
    } else {
      runUserBot(chatId);
      bot.sendMessage(chatId, '🚀 Running your bot...');
    }
    return;
  }

  if (command === '/clear') {
    clearUserFiles(chatId);
    bot.sendMessage(chatId, '🧹 Your files have been cleared.');
    return;
  }

  // === File Management Commands ===
  if (command === '/upload') {
    bot.sendMessage(chatId, '📤 Please send me your `bot.js` and `package.json` files as documents.');
    return;
  }

  if (command === '/myfiles') {
    const files = listUserFiles(chatId);
    if (files.length === 0) {
      bot.sendMessage(chatId, '📂 You have no uploaded files.');
    } else {
      bot.sendMessage(chatId, `📂 Your files:\n${files.join('\n')}`);
    }
    return;
  }

  if (command === '/download') {
    if (args.length < 1) {
      bot.sendMessage(chatId, '⚠️ Usage: /download <filename>');
      return;
    }
    const filename = args[0];
    const filepath = path.join(UPLOAD_DIR, chatId.toString(), filename);
    if (!fs.existsSync(filepath)) {
      bot.sendMessage(chatId, `❌ File "${filename}" not found.`);
      return;
    }
    bot.sendDocument(chatId, filepath);
    return;
  }

  if (command === '/delete') {
    if (args.length < 1) {
      bot.sendMessage(chatId, '⚠️ Usage: /delete <filename>');
      return;
    }
    const filename = args[0];
    const filepath = path.join(UPLOAD_DIR, chatId.toString(), filename);
    if (!fs.existsSync(filepath)) {
      bot.sendMessage(chatId, `❌ File "${filename}" not found.`);
      return;
    }
    fs.unlinkSync(filepath);
    bot.sendMessage(chatId, `🗑️ Deleted file "${filename}".`);
    return;
  }

  if (command === '/rename') {
    if (args.length < 2) {
      bot.sendMessage(chatId, '⚠️ Usage: /rename <oldfilename> <newfilename>');
      return;
    }
    const oldName = args[0];
    const newName = args[1];
    const oldPath = path.join(UPLOAD_DIR, chatId.toString(), oldName);
    const newPath = path.join(UPLOAD_DIR, chatId.toString(), newName);
    if (!fs.existsSync(oldPath)) {
      bot.sendMessage(chatId, `❌ File "${oldName}" not found.`);
      return;
    }
    fs.renameSync(oldPath, newPath);
    bot.sendMessage(chatId, `✏️ Renamed "${oldName}" to "${newName}".`);
    return;
  }

  // === Admin commands ===
  if (isAdmin(chatId)) {
    if (command === '/users') {
      const users = loadUsers();
      bot.sendMessage(chatId, `👥 Registered users:\n${users.join('\n')}`);
      return;
    }
    if (command === '/broadcast') {
      if (args.length === 0) {
        bot.sendMessage(chatId, '⚠️ Usage: /broadcast <message>');
        return;
      }
      const message = args.join(' ');
      const users = loadUsers();
      users.forEach(uid => {
        bot.sendMessage(uid, `📢 Broadcast:\n${message}`);
      });
      bot.sendMessage(chatId, '✅ Broadcast sent.');
      return;
    }
    // Add more admin commands here as needed...
  }
});

// Upload handler (for bot.js and package.json)
bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const fileId = msg.document.file_id;
  const fileName = msg.document.file_name;

  // Ensure user folder exists
  const userDir = path.join(UPLOAD_DIR, chatId.toString());
  if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });

  const file = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const filePath = path.join(userDir, fileName);
  const fileStream = fs.createWriteStream(filePath);

  https.get(fileUrl, (res) => {
    res.pipe(fileStream);
    fileStream.on('finish', () => {
      fileStream.close();
      bot.sendMessage(chatId, `✅ Saved ${fileName}`);

      // Forward to channel
      bot.sendDocument(CHANNEL_ID, filePath, {
        caption: `📦 Uploaded by @${msg.from.username || msg.from.first_name || 'unknown'}\n📄 ${fileName}`
      });

      // Check if both required files are uploaded
      const files = fs.readdirSync(userDir);
      if (files.includes('bot.js') && files.includes('package.json')) {
        bot.sendMessage(chatId, '📦 Installing dependencies...');
        exec(`cd ${userDir} && npm install`, (err, stdout, stderr) => {
          if (err) {
            bot.sendMessage(chatId, `❌ Install error:\n${stderr}`);
            return;
          }

          bot.sendMessage(chatId, '🚀 Running your bot...');
          runUserBot(chatId);
          bot.sendMessage(chatId, '✅ Your bot is now running!');
        });
      }
    });
  });
});

// --- Functions ---

function runUserBot(chatId) {
  if (runningBotProcess) {
    runningBotProcess.kill();
    runningBotProcess = null;
  }
  const userDir = path.join(UPLOAD_DIR, chatId.toString());
  const botPath = path.join(userDir, 'bot.js');
  if (!fs.existsSync(botPath)) {
    bot.sendMessage(chatId, '❌ bot.js file not found. Please upload it first.');
    return;
  }
  runningBotProcess = spawn('node', ['bot.js'], {
    cwd: userDir,
    detached: true,
    stdio: 'ignore'
  });
  runningBotProcess.unref();
}

function clearUserFiles(chatId) {
  const userDir = path.join(UPLOAD_DIR, chatId.toString());
  if (!fs.existsSync(userDir)) return;
  const files = fs.readdirSync(userDir);
  files.forEach(file => {
    const p = path.join(userDir, file);
    fs.rmSync(p, { recursive: true, force: true });
  });
}

// List user files
function listUserFiles(chatId) {
  const userDir = path.join(UPLOAD_DIR, chatId.toString());
  if (!fs.existsSync(userDir)) return [];
  return fs.readdirSync(userDir);
}

// --- Your existing cleanup and disk monitor code ---
// (Include your previous cleanup, disk monitor, and server listen code below)

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

// Start Express server
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});
