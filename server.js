const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { exec, spawn } = require('child_process');

const app = express();

// Hardcoded config
const BOT_TOKEN = 'YOUR_TELEGRAM_BOT_TOKEN_HERE';  // Replace with your Telegram bot token
const CHANNEL_ID = '-1002493057827';                // Your Telegram channel ID
const PORT = 3000;                                  // Port to listen on

// Gemini API keys from environment variable (comma-separated)
const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || '')
  .split(',')
  .map(k => k.trim())
  .filter(k => k);

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const BASE_DIR = __dirname;
const UPLOAD_DIR = path.join(BASE_DIR, 'userbot');
const USERS_FILE = path.join(BASE_DIR, 'users.json');
const HISTORY_FILE = path.join(BASE_DIR, 'gemini_history.json');
const KEEP_FILES = ['server.js', 'package.json', 'users.json', 'node_modules'];

// Ensure directories and files exist
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([]));
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify({}));

const signature = '\n\n— Kaustav Ray, founder';

// Express health check route
app.get('/', (req, res) => {
  res.send('🤖 Bot Code Maker is live. – Kaustav Ray, founder');
});

// Load and save users helpers
function loadUsers() {
  return JSON.parse(fs.readFileSync(USERS_FILE));
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users));
}

// Load and save AI chat history helpers
function loadHistory() {
  return JSON.parse(fs.readFileSync(HISTORY_FILE));
}
function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}
function addToHistory(userId, text) {
  const history = loadHistory();
  if (!history[userId]) history[userId] = [];
  history[userId].unshift(text);
  if (history[userId].length > 10) history[userId] = history[userId].slice(0, 10);
  saveHistory(history);
}

// /start command handler
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  let users = loadUsers();
  if (!users.includes(chatId)) {
    users.push(chatId);
    saveUsers(users);
  }

  const welcomeMsg =
    `👋 Hello! I am your *Bot Code Maker* 🤖.` +
    `\nSend me any message and I will chat with you using Gemini AI.` +
    `\nUse /history to see your last 10 AI chat responses.` +
    signature;

  bot.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown' });
});

// /history command handler
bot.onText(/\/history/, (msg) => {
  const chatId = msg.chat.id;
  const history = loadHistory();
  const entries = history[chatId.toString()] || [];

  if (entries.length === 0) {
    return bot.sendMessage(chatId, '🕰️ You have no previous AI chat responses.' + signature);
  }

  let reply = '🧠 *Your Last 10 AI Chat Responses:*\n\n';
  entries.forEach((entry, index) => {
    reply += `*${index + 1}.* ${entry.slice(0, 200).replace(/[\r\n]+/g, ' ')}...\n\n`;
  });

  bot.sendMessage(chatId, reply + signature, { parse_mode: 'Markdown' });
});

// Gemini API call with fallback for multiple keys
async function callGemini(prompt) {
  if (GEMINI_KEYS.length === 0) {
    throw new Error('No Gemini API keys provided.');
  }

  const startIndex = Math.floor(Math.random() * GEMINI_KEYS.length);
  const keysToTry = [];
  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    keysToTry.push(GEMINI_KEYS[(startIndex + i) % GEMINI_KEYS.length]);
  }

  for (let i = 0; i < keysToTry.length; i++) {
    const apiKey = keysToTry[i];
    try {
      const response = await new Promise((resolve, reject) => {
        const options = {
          hostname: 'generativelanguage.googleapis.com',
          path: `/v1beta/models/gemini-pro:generateContent?key=${apiKey}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        };

        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', chunk => (data += chunk));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
              if (!text) throw new Error('Empty response');
              resolve(text);
            } catch (err) {
              reject(err);
            }
          });
        });

        req.on('error', reject);
        req.write(
          JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
          })
        );
        req.end();
      });

      return response;
    } catch (err) {
      console.warn(`❌ Gemini key attempt #${i + 1} failed: ${err.message}. Trying next key...`);
    }
  }

  throw new Error('All Gemini API keys failed.');
}

// AI chat for normal text messages (skip commands)
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  if (!msg.text || msg.text.startsWith('/')) return;

  try {
    bot.sendChatAction(chatId, 'typing');

    const userMessage = msg.text.trim();
    const aiResponse = await callGemini(userMessage);

    addToHistory(chatId.toString(), aiResponse);

    bot.sendMessage(chatId, aiResponse + signature);
  } catch (err) {
    bot.sendMessage(chatId, '❌ AI error:\n' + err.message + signature);
  }
});

// Handle file uploads
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
      bot.sendMessage(chatId, `✅ Saved ${fileName}` + signature);

      // Forward file to admin channel
      bot.sendDocument(CHANNEL_ID, filePath, {
        caption: `📦 Uploaded by @${msg.from.username || msg.from.first_name || 'unknown'}\n📄 ${fileName}`
      });

      // Auto-run bot.js if both files exist
      const files = fs.readdirSync(UPLOAD_DIR);
      if (files.includes('bot.js') && files.includes('package.json')) {
        bot.sendMessage(chatId, '📦 Installing dependencies...');
        exec(`cd ${UPLOAD_DIR} && npm install`, (err, stdout, stderr) => {
          if (err) {
            bot.sendMessage(chatId, `❌ Install error:\n${stderr}` + signature);
            return;
          }

          bot.sendMessage(chatId, '🚀 Running your bot...');
          const child = spawn('node', ['bot.js'], {
            cwd: UPLOAD_DIR,
            detached: true,
            stdio: 'ignore'
          });
          child.unref();

          bot.sendMessage(chatId, '✅ Your bot is now running!' + signature);
        });
      }
    });
  });
});

// Start Express server
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});
