#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# openclaw-medical entrypoint
#
# 1. Verifies baked-in models and database exist
# 2. Delegates to openclaw-nvidia-start (inference.local + gateway + policy-proxy)
# 3. Optionally starts messaging bridges based on environment variables
#
# Required env vars (inherited from openclaw-nvidia-start):
#   CHAT_UI_URL  — URL where the chat UI will be accessed
#
# Optional env vars:
#   TELEGRAM_BOT_TOKEN   — starts Telegram bridge if set
#   DISCORD_BOT_TOKEN    — starts Discord bridge if set
#   NVIDIA_INFERENCE_API_KEY — passed through to openclaw-nvidia-start
#   NVIDIA_INTEGRATE_API_KEY — passed through to openclaw-nvidia-start

set -euo pipefail

# ── Verify models ─────────────────────────────────────────────────────
echo "[medical-sandbox] Checking baked-in models..."
for model_dir in /sandbox/models/medical-embedding; do
    if [ -d "$model_dir" ]; then
        echo "  Found: $model_dir"
    else
        echo "  WARNING: Model directory $model_dir not found"
    fi
done

# Placeholder check for future models
# for model_dir in /sandbox/models/entity-extraction; do ...

# ── Verify database ──────────────────────────────────────────────────
if [ -f /sandbox/data/medical.db ]; then
    echo "[medical-sandbox] Database: /sandbox/data/medical.db ($(du -h /sandbox/data/medical.db | cut -f1))"
else
    echo "[medical-sandbox] WARNING: Database /sandbox/data/medical.db not found"
fi

# ── Start OpenClaw + inference.local routing + policy-proxy ──────────
# This is the core startup from openclaw-nvidia. It:
#   - Injects NVIDIA API keys into the UI bundle
#   - Onboards OpenClaw with --custom-base-url "https://inference.local/v1"
#   - Starts the OpenClaw gateway on port 18788
#   - Starts the policy-proxy on port 18789
#   - Outputs the chat UI URL
echo "[medical-sandbox] Starting OpenClaw gateway and inference routing..."
source /usr/local/bin/openclaw-nvidia-start

# ── Conditionally start messaging bridges ────────────────────────────

if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
    echo "[medical-sandbox] Starting Telegram bridge..."
    nohup /sandbox/.venv/bin/python /sandbox/bridges/telegram-bridge.py \
        >> /tmp/telegram-bridge.log 2>&1 &
    echo "[medical-sandbox] Telegram bridge started (pid $!, log: /tmp/telegram-bridge.log)"
fi

if [ -n "${DISCORD_BOT_TOKEN:-}" ]; then
    echo "[medical-sandbox] Starting Discord bridge..."
    nohup /sandbox/.venv/bin/python /sandbox/bridges/discord-bridge.py \
        >> /tmp/discord-bridge.log 2>&1 &
    echo "[medical-sandbox] Discord bridge started (pid $!, log: /tmp/discord-bridge.log)"
fi

echo ""
echo "[medical-sandbox] Ready."
echo "  Models:   /sandbox/models/"
echo "  Database: /sandbox/data/medical.db"
echo "  Bridges:  ${TELEGRAM_BOT_TOKEN:+telegram }${DISCORD_BOT_TOKEN:+discord }${TELEGRAM_BOT_TOKEN:-${DISCORD_BOT_TOKEN:-none}}"
echo ""
