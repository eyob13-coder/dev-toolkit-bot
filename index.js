import { GoogleGenAI } from "@google/genai";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
dotenv.config();
import db from "./firebase.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const awaitingSnippets = {};

// ─────── Helper Functions ───────
// Replace splitMessage with a version that handles code blocks safely
function splitMessageWithCodeBlock(text, maxLength = 3000, lang = "") {
  const codeBlockStart = `\u0060\u0060\u0060${lang}\n`;
  const codeBlockEnd = `\n\u0060\u0060\u0060`;
  const maxContentLength = maxLength - codeBlockStart.length - codeBlockEnd.length;
  const parts = [];
  for (let i = 0; i < text.length; i += maxContentLength) {
    parts.push(codeBlockStart + text.slice(i, i + maxContentLength) + codeBlockEnd);
  }
  return parts;
}

// function escapeMarkdown(text) {
//   return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
// }

// ─────── Welcome ───────
bot.onText(/\/start/i, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `👋 Welcome to *Dev Toolkit Bot* 🛠️

Here's what I can do:
💾 /save <name> – Save a code snippet  
📂 /get <name> – Retrieve your snippet  
🎨 /format <language> – Format code (Python, JS, etc.)  
🧠 /helpme – Paste your error and get AI help  
📚 /commands – List of commands  
📜 /list – List your saved snippets  
🗑️ /delete <name> – Delete a snippet`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/commands/i, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `📚 *Dev Toolkit Commands*:

💾 /save <name> – Save your code snippet  
📂 /get <name> – Retrieve a saved snippet  
🎨 /format <language> – Format code in any language  
🧠 /helpme – Get AI help for code errors  
📜 /list – List all your saved snippets  
🗑️ /delete <name> – Delete a snippet`,
    { parse_mode: "Markdown" }
  );
});

// ─────── Firestore Methods ───────
async function saveSnippet(userId, name, code) {
  return db.collection("snippets").doc(`${userId}_${name}`).set({
    userId,
    name,
    code,
    timestamp: Date.now(),
  });
}

async function getSnippet(userId, name) {
  const doc = await db.collection("snippets").doc(`${userId}_${name}`).get();
  return doc.exists ? doc.data().code : null;
}

// ─────── /save <name> ───────
bot.onText(/\/save (.+)/i, (msg, match) => {
  const name = match[1].trim();
  awaitingSnippets[msg.from.id] = { action: "save", name };
  bot.sendMessage(msg.chat.id, `✏️ Send the code you want to save as *${name}*`, { parse_mode: "Markdown" });
});

// ─────── /get <name> ───────
bot.onText(/\/get (.+)/i, async (msg, match) => {
  const name = match[1].trim();
  const code = await getSnippet(msg.from.id, name);
  const chatId = msg.chat.id;

  if (code) {
    const parts = splitMessageWithCodeBlock(code, 3000);
    for (const part of parts) {
      await bot.sendMessage(chatId, `📂 *${name}*:\n${part}`, { parse_mode: "Markdown" });
    }
  } else {
    bot.sendMessage(chatId, `❌ No snippet found named *${name}*`, { parse_mode: "Markdown" });
  }
});

// ─────── /format <lang> ───────
bot.onText(/\/format (.+)/i, (msg, match) => {
  const lang = match[1].trim().toLowerCase();
  awaitingSnippets[msg.from.id] = { action: "format", lang };
  bot.sendMessage(msg.chat.id, `📥 Send your ${lang} code and I'll format it using Gemini AI.`);
});

// ─────── /helpme ───────
bot.onText(/\/helpme/i, (msg) => {
  awaitingSnippets[msg.from.id] = { action: "error" };
  bot.sendMessage(msg.chat.id, `💥 Send your error message or stack trace, and I'll try to help using Gemini.`);
});

// ─────── /list ───────
bot.onText(/\/list/i, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const snapshot = await db.collection("snippets").where("userId", "==", userId).get();

  if (snapshot.empty) return bot.sendMessage(chatId, "📂 You have no saved snippets.");

  const names = snapshot.docs.map((doc) => doc.data().name).join("\n• ");
  bot.sendMessage(chatId, `📂 Your snippets:\n• ${names}`);
});

// ─────── /delete <name> ───────
bot.onText(/\/delete (.+)/i, async (msg, match) => {
  const name = match[1].trim();
  const docRef = db.collection("snippets").doc(`${msg.from.id}_${name}`);
  const doc = await docRef.get();

  if (!doc.exists) {
    return bot.sendMessage(msg.chat.id, `❌ No snippet named *${name}* found.`, { parse_mode: "Markdown" });
  }

  await docRef.delete();
  bot.sendMessage(msg.chat.id, `🗑️ Snippet *${name}* deleted.`, { parse_mode: "Markdown" });
});

// ─────── Message Handler ───────
bot.on("message", async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const userState = awaitingSnippets[userId];

  if (!userState || !msg.text || msg.text.startsWith("/")) return;

  try {
    switch (userState.action) {
      case "save":
        await saveSnippet(userId, userState.name, msg.text);
        bot.sendMessage(chatId, `✅ Snippet *${userState.name}* saved!`, { parse_mode: "Markdown" });
        break;

      case "format": {
        const result = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: `Please format the following ${userState.lang} code properly:\n\n${msg.text}`,
        });
        const parts = splitMessageWithCodeBlock(result.text.trim(), 3000, userState.lang);
        for (const part of parts) {
          await bot.sendMessage(chatId, `🎨 *Formatted ${userState.lang} code:*\n${part}`, { parse_mode: "Markdown" });
        }
        break;
      }

      case "error": {
        const result = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: `I got this error:\n\n${msg.text}\n\nExplain it clearly and suggest how to fix it.`,
        });
        const parts = splitMessageWithCodeBlock(result.text.trim(), 3000);
        for (const part of parts) {
          await bot.sendMessage(chatId, `🤖 *Gemini AI says:*\n${part}`, { parse_mode: "Markdown" });
        }
        break;
      }
    }
  } catch (err) {
    console.error("🔥 Handler error:", err.message);
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  } finally {
    delete awaitingSnippets[userId];
  }
});

// ─────── Polling Error Logger ───────
bot.on("polling_error", (err) => {
  console.error("🛑 Polling error:", err.message);
});
