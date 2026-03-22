#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# openclaw-medical entrypoint
#
# 1. Downloads models on first startup if not present
# 2. Delegates to openclaw-nvidia-start (inference.local + gateway + policy-proxy)
# 3. Optionally starts messaging bridges based on environment variables
#
# Optional env vars:
#   TELEGRAM_BOT_TOKEN   — starts Telegram bridge if set
#   DISCORD_BOT_TOKEN    — starts Discord bridge if set
#   NVIDIA_INFERENCE_API_KEY — passed through to openclaw-nvidia-start
#   NVIDIA_INTEGRATE_API_KEY — passed through to openclaw-nvidia-start

set -euo pipefail

# ── Default CHAT_UI_URL ────────────────────────────────────────────────
# OpenShell's SSH supervisor calls env_clear(), so env vars from the CLI
# create command don't reach the sandbox process. Default to local access.
export CHAT_UI_URL="${CHAT_UI_URL:-http://127.0.0.1:18789}"

# ── Download models on first startup ──────────────────────────────────
# Models are NOT baked into the image (keeps it small for K3s push).
# They download on first run and persist in /sandbox/models/.
if [ ! -d /sandbox/models/medical-embedding ] || [ -z "$(ls -A /sandbox/models/medical-embedding 2>/dev/null)" ]; then
    echo "[medical-sandbox] Downloading models (first run only, this takes a few minutes)..."
    /sandbox/.venv/bin/python /sandbox/download-models.py
else
    echo "[medical-sandbox] Models already present, skipping download."
fi

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
