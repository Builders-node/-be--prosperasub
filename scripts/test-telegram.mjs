import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const envPath = path.join(root, ".env");

function parseEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};

  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .reduce((env, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return env;

      const index = trimmed.indexOf("=");
      const key = trimmed.slice(0, index).trim();
      const rawValue = trimmed.slice(index + 1).trim();
      env[key] = rawValue.replace(/^["']|["']$/g, "");
      return env;
    }, {});
}

const localEnv = parseEnv(envPath);
const token = process.env.TELEGRAM_BOT_TOKEN || localEnv.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID || localEnv.TELEGRAM_ADMIN_CHAT_ID;

if (!token || !chatId) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID.");
  console.error("Add them to backend/.env or export them in your shell, then run npm run telegram:test.");
  process.exit(1);
}

const message = [
  "<b>ProsperaSub Telegram test</b>",
  "",
  "Your private admin group is connected.",
  `Sent at: ${new Date().toISOString()}`
].join("\n");

const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    chat_id: chatId,
    text: message,
    parse_mode: "HTML",
    disable_web_page_preview: true
  })
});

const body = await response.json().catch(() => null);
if (!response.ok) {
  console.error(body?.description || `Telegram returned ${response.status}`);
  process.exit(1);
}

console.log(`Telegram test message sent to chat ${chatId}.`);
