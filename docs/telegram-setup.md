# Telegram notifications — setup guide

taskpapr can send you a daily digest of tasks due today and tomorrow via Telegram. This guide walks through the complete setup from scratch, assuming you've never used the Telegram Bot API before.

---

## What you'll get

A message like this, delivered each morning at a time you choose:

```
📋 taskpapr reminder

Due today (2026-03-02):
  • Pay credit card [Personal]
  • Weekly review [Work]

Due tomorrow (2026-03-03):
  • Call accountant [Work]
```

---

## Step 1 — Create a Telegram bot

You create bots by talking to a bot called **@BotFather**. This is the official, Telegram-provided tool.

1. Open Telegram (desktop or mobile)
2. Search for **@BotFather** and open the chat (look for the blue verified tick)
3. Send the command:
   ```
   /newbot
   ```
4. BotFather will ask for a **name** — this is the display name, e.g. `taskpapr`
5. BotFather will then ask for a **username** — must end in `bot`, e.g. `my_taskpapr_bot`
6. BotFather will reply with your **bot token**, which looks like:
   ```
   123456789:ABCdefGHIjklMNOpqrSTUvwxYZ123456789
   ```

**Keep this token private.** Anyone with it can send messages as your bot.

Copy the token — you'll need it in Step 3.

---

## Step 2 — Get your chat ID

Your chat ID is the unique number that tells the bot where to send messages. The easiest way to find it:

1. In Telegram, search for your new bot by its username and open the chat
2. Send it any message (e.g. `hello`)
3. In a browser, open this URL (replace `<TOKEN>` with your actual token):
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
4. You'll see a JSON response. Find the `"chat"` object — your ID is the `"id"` field:
   ```json
   {
     "message": {
       "chat": {
         "id": 987654321,
         "first_name": "James",
         "type": "private"
       }
     }
   }
   ```
5. Copy that number (e.g. `987654321`) — that's your chat ID

> **Nothing showing up?** Make sure you sent a message to the bot *after* creating it. The `getUpdates` endpoint only returns messages received after the bot was created.

---

## Step 3 — Add the credentials to your `.env`

Open your `.env` file (copy from `.env.example` if you haven't already) and fill in:

```env
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrSTUvwxYZ123456789
TELEGRAM_CHAT_ID=987654321
TELEGRAM_NOTIFY_HOUR=8
```

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | The token from BotFather (Step 1) |
| `TELEGRAM_CHAT_ID` | Your personal chat ID (Step 2) |
| `TELEGRAM_NOTIFY_HOUR` | 24-hour local time for the daily digest (default: `8` = 8am) |

`TELEGRAM_CHAT_ID` in `.env` is the **server-level fallback** — it's used for any user who hasn't set their own chat ID. For a single-user setup this is all you need.

---

## Step 4 — Restart the server

The server reads environment variables at startup. After editing `.env`, restart:

```bash
# Local dev
npm start

# EC2 / systemd
sudo systemctl restart taskpapr-dev

# Docker
docker compose restart
```

You'll see a log line confirming the notification schedule:

```
[telegram] next notification scheduled for 3/2/2026, 8:00:00 AM (in 240 min)
```

---

## Step 5 — Test it

You don't have to wait until 8am. Use the test button in Settings:

1. Open taskpapr → click your user avatar → **⚙ Settings**
2. Scroll to the **Telegram** section
3. Enter your chat ID if it's not pre-filled (for multi-user setups — see below)
4. Click **Send test notification**

You should receive a message within a few seconds. If you have no tasks due today or tomorrow, the response will say so — that's correct behaviour, not an error.

---

## Per-user chat IDs (multi-user setup)

If multiple people use your taskpapr instance, each user can set their own Telegram chat ID so they only receive their own tasks.

1. Each user opens **⚙ Settings → Telegram**
2. Enters their own chat ID (found using the same `getUpdates` method above — they each message your bot)
3. Clicks **Save** and **Send test notification**

The server-level `TELEGRAM_CHAT_ID` in `.env` acts as a fallback for any user who hasn't set one.

> **Note:** All users message the **same bot** — the bot just sends to different chat IDs. You don't need a separate bot per user.

---

## Troubleshooting

**"TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — notifications disabled"**
The server started without the env vars. Check your `.env` file and restart.

**"No tasks due today or tomorrow"**
Working correctly — no notification is sent if there's nothing due. Try adding a task with today's date to test.

**The bot sends a message but `getUpdates` was empty**
Make sure you messaged the bot at least once from your Telegram account *before* calling `getUpdates`. The bot needs at least one inbound message to know your chat ID.

**Wrong time zone**
`TELEGRAM_NOTIFY_HOUR` uses the server's local time. If your server is set to UTC and you want 8am London time, set `TELEGRAM_NOTIFY_HOUR=8` and ensure your server's timezone is correct (`timedatectl` on Linux), or adjust the hour to match UTC offset.

**I got a `403 Forbidden` from the Telegram API**
The user hasn't messaged the bot yet. Telegram bots can only send messages to users who have initiated a conversation first. Ask the user to send any message to the bot, then retry.

---

## How the daily digest works

- The digest runs once per day at `TELEGRAM_NOTIFY_HOUR`
- It also runs ~10 seconds after the server starts (catches the case where you restart the server after 8am)
- Only tasks with a `next_due` date set to **today** or **tomorrow** are included
- Dormant tasks are excluded (they're sleeping — you don't need a reminder for them yet)
- Done tasks are excluded
- The debug date override (admin → Debug tools) affects what "today" means for the digest — useful for testing