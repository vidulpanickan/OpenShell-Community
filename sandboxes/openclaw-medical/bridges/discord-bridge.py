# SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Discord messaging bridge for openclaw-medical sandbox.

Forwards messages from Discord to the OpenClaw agent running inside the sandbox
via the local OpenClaw gateway API. Responses are sent back to Discord.

This bridge runs as a Python process INSIDE the sandbox. The policy grants
/sandbox/.venv/bin/python access to discord.com and gateway.discord.gg only —
the agent runtime (node) cannot reach Discord APIs.

Env:
    DISCORD_BOT_TOKEN   — Bot token from Discord Developer Portal (required)
    OPENCLAW_GATEWAY    — Gateway URL (default: http://127.0.0.1:18788)
    DISCORD_CHANNEL_IDS — Comma-separated channel IDs to listen in (optional, listens to all if unset)
"""

import json
import logging
import os
import urllib.request
import urllib.error

import discord

logging.basicConfig(
    format="[discord-bridge] %(asctime)s %(levelname)s: %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

TOKEN = os.environ.get("DISCORD_BOT_TOKEN", "")
GATEWAY = os.environ.get("OPENCLAW_GATEWAY", "http://127.0.0.1:18788")
ALLOWED_CHANNELS = None

if os.environ.get("DISCORD_CHANNEL_IDS"):
    ALLOWED_CHANNELS = {
        int(cid.strip()) for cid in os.environ["DISCORD_CHANNEL_IDS"].split(",")
    }


def _is_allowed(channel_id: int) -> bool:
    if ALLOWED_CHANNELS is None:
        return True
    return channel_id in ALLOWED_CHANNELS


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


# Discord client with message content intent
intents = discord.Intents.default()
intents.message_content = True
client = discord.Client(intents=intents)


@client.event
async def on_ready():
    logger.info("Connected as %s (id: %d)", client.user.name, client.user.id)
    if ALLOWED_CHANNELS:
        logger.info("Listening in channels: %s", ALLOWED_CHANNELS)
    else:
        logger.info("Listening in all channels (no DISCORD_CHANNEL_IDS set)")


@client.event
async def on_message(message: discord.Message):
    # Ignore own messages
    if message.author == client.user:
        return

    # Ignore messages not in allowed channels
    if not _is_allowed(message.channel.id):
        return

    # Only respond to mentions or DMs
    is_dm = isinstance(message.channel, discord.DMChannel)
    is_mentioned = client.user in message.mentions
    if not is_dm and not is_mentioned:
        return

    # Strip the bot mention from the message text
    text = message.content
    if is_mentioned:
        text = text.replace(f"<@{client.user.id}>", "").strip()

    if not text:
        return

    user_name = message.author.display_name
    logger.info("[%d] %s: %s", message.channel.id, user_name, text[:100])

    # Send typing indicator
    async with message.channel.typing():
        # Forward to agent (blocking call — runs in executor)
        session_id = f"discord-{message.channel.id}"
        response = await client.loop.run_in_executor(
            None, send_to_agent, text, session_id
        )

    logger.info("[%d] agent: %s", message.channel.id, response[:100])

    # Send response, chunking if needed (Discord max: 2000 chars)
    for i in range(0, len(response), 1900):
        chunk = response[i : i + 1900]
        await message.reply(chunk)


def main() -> None:
    if not TOKEN:
        logger.error("DISCORD_BOT_TOKEN environment variable is required")
        raise SystemExit(1)

    logger.info("Starting Discord bridge (gateway: %s)", GATEWAY)
    client.run(TOKEN, log_handler=None)


if __name__ == "__main__":
    main()
