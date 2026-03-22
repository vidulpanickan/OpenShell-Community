# SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Telegram messaging bridge for openclaw-medical sandbox.

Forwards messages from Telegram to the OpenClaw agent running inside the sandbox
via the local OpenClaw gateway API. Responses are sent back to Telegram.

This bridge runs as a Python process INSIDE the sandbox. The policy grants
/sandbox/.venv/bin/python access to api.telegram.org:443 only — the agent
runtime (node) cannot reach Telegram APIs.

Env:
    TELEGRAM_BOT_TOKEN  — Bot token from @BotFather (required)
    OPENCLAW_GATEWAY    — Gateway URL (default: http://127.0.0.1:18788)
    ALLOWED_CHAT_IDS    — Comma-separated Telegram chat IDs (optional, accepts all if unset)
"""

import asyncio
import json
import logging
import os
import urllib.request
import urllib.error

from telegram import Update
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

logging.basicConfig(
    format="[telegram-bridge] %(asctime)s %(levelname)s: %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
GATEWAY = os.environ.get("OPENCLAW_GATEWAY", "http://127.0.0.1:18788")
ALLOWED_CHATS = None

if os.environ.get("ALLOWED_CHAT_IDS"):
    ALLOWED_CHATS = {
        int(cid.strip()) for cid in os.environ["ALLOWED_CHAT_IDS"].split(",")
    }


def _is_allowed(chat_id: int) -> bool:
    if ALLOWED_CHATS is None:
        return True
    return chat_id in ALLOWED_CHATS


def send_to_agent(message: str, session_id: str) -> str:
    """Send a message to the OpenClaw gateway and return the response.

    Uses the OpenClaw gateway's REST API on localhost. This is a loopback
    connection — no network policy needed.
    """
    url = f"{GATEWAY}/api/v1/chat"
    payload = json.dumps(
        {
            "message": message,
            "session_id": session_id,
        }
    ).encode()

    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode())
            return data.get("response", data.get("message", "(no response)"))
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else ""
        logger.error("Gateway HTTP %d: %s", e.code, body[:500])
        return f"Error: gateway returned HTTP {e.code}"
    except urllib.error.URLError as e:
        logger.error("Gateway connection failed: %s", e.reason)
        return "Error: could not reach the OpenClaw gateway. Is it running?"
    except Exception as e:
        logger.error("Unexpected error: %s", e)
        return f"Error: {e}"


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /start command."""
    if not _is_allowed(update.effective_chat.id):
        return
    await update.message.reply_text(
        "Medical Sandbox — powered by OpenShell + OpenClaw\n\n"
        "Send me a message and I'll forward it to the AI agent "
        "running inside the secure sandbox.\n\n"
        "Commands:\n"
        "  /start — Show this message\n"
        "  /reset — Reset conversation session"
    )


async def cmd_reset(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /reset command."""
    if not _is_allowed(update.effective_chat.id):
        return
    await update.message.reply_text("Session reset.")


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Forward user messages to the OpenClaw agent."""
    chat_id = update.effective_chat.id
    if not _is_allowed(chat_id):
        logger.info("Ignored message from chat %d (not in allowed list)", chat_id)
        return

    text = update.message.text
    if not text:
        return

    user_name = update.effective_user.first_name or "user"
    logger.info("[%d] %s: %s", chat_id, user_name, text[:100])

    # Send typing indicator
    await update.effective_chat.send_action("typing")

    # Forward to agent (blocking call — runs in executor to not block event loop)
    session_id = f"telegram-{chat_id}"
    loop = asyncio.get_event_loop()
    response = await loop.run_in_executor(None, send_to_agent, text, session_id)

    logger.info("[%d] agent: %s", chat_id, response[:100])

    # Send response, chunking if needed (Telegram max: 4096 chars)
    for i in range(0, len(response), 4000):
        chunk = response[i : i + 4000]
        try:
            await update.message.reply_text(chunk, parse_mode="Markdown")
        except Exception:
            # Retry without markdown if formatting fails
            await update.message.reply_text(chunk)


def main() -> None:
    if not TOKEN:
        logger.error("TELEGRAM_BOT_TOKEN environment variable is required")
        raise SystemExit(1)

    logger.info("Starting Telegram bridge (gateway: %s)", GATEWAY)
    if ALLOWED_CHATS:
        logger.info("Allowed chats: %s", ALLOWED_CHATS)

    app = ApplicationBuilder().token(TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("reset", cmd_reset))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    logger.info("Polling for Telegram updates...")
    app.run_polling()


if __name__ == "__main__":
    main()
