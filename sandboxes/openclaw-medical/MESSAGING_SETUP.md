# Messaging Bridge Setup Guide

Step-by-step instructions for connecting the medical sandbox to Telegram and Discord.
The bridges let users chat with the AI agent from their messaging app.

---

## Telegram Setup

### Step 1: Create a Telegram bot

1. Open Telegram and search for `@BotFather`
2. Send `/newbot`
3. Choose a display name (e.g., "Medical Sandbox")
4. Choose a username (must end in `bot`, e.g., `medical_sandbox_bot`)
5. BotFather replies with your bot token — looks like `7123456789:AAHx...`. Copy it.

### Step 2: (Optional) Restrict who can use the bot

By default the bridge accepts messages from anyone. To restrict it, get the Telegram
chat IDs of allowed users:

1. Message your bot in Telegram (just send "hello")
2. Open this URL in a browser, replacing `<YOUR_TOKEN>` with the token from step 1:
   ```
   https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
   ```
3. Look for `"chat":{"id":123456789}` in the response — that number is the chat ID
4. Repeat for each user you want to allow. Collect all the IDs.

### Step 3: Launch the sandbox with Telegram

```bash
openshell sandbox create --name medical \
    --from openclaw-medical \
    --forward 18789 \
    -- env CHAT_UI_URL=http://127.0.0.1:18789 \
           NVIDIA_INFERENCE_API_KEY="${NVIDIA_API_KEY}" \
           TELEGRAM_BOT_TOKEN="7123456789:AAHxYourTokenHere" \
           ALLOWED_CHAT_IDS="123456789,987654321" \
           medical-start
```

Leave out `ALLOWED_CHAT_IDS` to let anyone message the bot.

### Using the Telegram bot

- `/start` — Shows a welcome message
- `/reset` — Resets the conversation
- Any other message is forwarded to the AI agent

The bot will show a "typing..." indicator while the agent is working.

---

## Discord Setup

### Step 1: Create a Discord application

1. Go to https://discord.com/developers/applications
2. Click **New Application**
3. Give it a name (e.g., "Medical Sandbox") and click **Create**

### Step 2: Create the bot and get the token

1. In the left sidebar, click **Bot**
2. Click **Reset Token** and copy the token — looks like `MTIz...`. Save it somewhere safe.
3. Scroll down to **Privileged Gateway Intents**
4. Turn on **Message Content Intent** (the bot needs this to read messages)

### Step 3: Invite the bot to your server

1. In the left sidebar, click **OAuth2**
2. Under **OAuth2 URL Generator**, check the `bot` scope
3. Under **Bot Permissions**, check these three:
   - Read Messages/View Channels
   - Send Messages
   - Read Message History
4. Copy the URL at the bottom of the page
5. Open it in your browser, pick your server, and click **Authorize**

### Step 4: (Optional) Restrict which channels the bot listens in

By default the bot responds in any channel where it's mentioned. To restrict it:

1. In Discord, right-click a channel name and click **Copy Channel ID**
   - If you don't see this option: go to Discord Settings → App Settings → Advanced → turn on **Developer Mode**
2. Repeat for each channel you want the bot to listen in

### Step 5: Launch the sandbox with Discord

```bash
openshell sandbox create --name medical \
    --from openclaw-medical \
    --forward 18789 \
    -- env CHAT_UI_URL=http://127.0.0.1:18789 \
           NVIDIA_INFERENCE_API_KEY="${NVIDIA_API_KEY}" \
           DISCORD_BOT_TOKEN="MTIzNDU2Nzg5.YourTokenHere" \
           DISCORD_CHANNEL_IDS="1234567890,9876543210" \
           medical-start
```

Leave out `DISCORD_CHANNEL_IDS` to let the bot respond in any channel where it's mentioned.

### Using the Discord bot

- **Mention it**: `@Medical Sandbox what is the dosage for ibuprofen?`
- **DM it**: Send a direct message — no mention needed
- The bot replies in the same channel or DM thread

---

## Running Both Bridges Together

Pass both tokens in the same command:

```bash
openshell sandbox create --name medical \
    --from openclaw-medical \
    --forward 18789 \
    -- env CHAT_UI_URL=http://127.0.0.1:18789 \
           NVIDIA_INFERENCE_API_KEY="${NVIDIA_API_KEY}" \
           TELEGRAM_BOT_TOKEN="7123456789:AAHxYourTokenHere" \
           DISCORD_BOT_TOKEN="MTIzNDU2Nzg5.YourTokenHere" \
           medical-start
```

---

## Troubleshooting

**Check bridge logs** (connect to the sandbox first):

```bash
openshell sandbox connect medical

# Inside the sandbox:
cat /tmp/telegram-bridge.log
cat /tmp/discord-bridge.log
```

**Telegram bot not responding?**
- Verify the token: `curl https://api.telegram.org/bot<TOKEN>/getMe`
- Check that the bot isn't already running elsewhere (only one process can poll a bot token)

**Discord bot not responding?**
- Make sure **Message Content Intent** is enabled in the Discord Developer Portal
- Make sure you're mentioning the bot (`@BotName`) or DMing it — it doesn't read every message
- Check that the bot has "Read Messages" and "Send Messages" permissions in the channel
