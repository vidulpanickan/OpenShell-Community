# syntax=docker/dockerfile:1.4

# SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# openclaw-medical sandbox image
#
# Builds on openclaw-nvidia (which provides inference.local routing, policy-proxy,
# and the NeMoClaw DevX UI extension) and adds:
#   - Medical embedding model (baked in from HuggingFace)
#   - SQLite database with medical schema
#   - Telegram and Discord messaging bridges (Python)
#   - HuggingFace and PyPI network policies for runtime model/package management
#
# All LLM inference goes through inference.local — no direct API access from the
# agent runtime (node). See workflow_readme.md for the full security model.
#
# Build:
#   docker build -t openclaw-medical .
#
# Run:
#   openshell sandbox create --name medical \
#     --from openclaw-medical \
#     --forward 18789 \
#     -- env CHAT_UI_URL=http://127.0.0.1:18789 \
#            NVIDIA_INFERENCE_API_KEY=<key> \
#            medical-start

ARG BASE_IMAGE=ghcr.io/nvidia/openshell-community/sandboxes/openclaw-nvidia:latest
FROM ${BASE_IMAGE}

USER root

# ── System dependencies ──────────────────────────────────────────────
RUN apt-get update && \
    apt-get install -y --no-install-recommends sqlite3 && \
    rm -rf /var/lib/apt/lists/*

# ── Python ML and messaging dependencies ─────────────────────────────
# Install into the existing /sandbox/.venv from the base image.
# Using CPU-only torch to keep image size manageable.
RUN /sandbox/.venv/bin/pip install --no-cache-dir \
    torch --index-url https://download.pytorch.org/whl/cpu
RUN /sandbox/.venv/bin/pip install --no-cache-dir \
    transformers \
    sentence-transformers \
    huggingface-hub \
    python-telegram-bot \
    "discord.py>=2.0"

# ── Download HuggingFace models at build time ────────────────────────
# Models are baked into the image so they're available instantly on startup
# without requiring runtime HuggingFace network access.
COPY download-models.py /tmp/download-models.py
RUN /sandbox/.venv/bin/python /tmp/download-models.py && \
    rm /tmp/download-models.py

# ── Set up SQLite database ───────────────────────────────────────────
COPY setup-database.sh /tmp/setup-database.sh
RUN chmod +x /tmp/setup-database.sh && \
    /tmp/setup-database.sh && \
    rm /tmp/setup-database.sh

# ── Install sandbox policy ───────────────────────────────────────────
# Overrides openclaw-nvidia policy with our version (adds messaging + HF policies).
RUN mkdir -p /etc/openshell
COPY policy.yaml /etc/openshell/policy.yaml

# ── Install messaging bridges ────────────────────────────────────────
COPY bridges/ /sandbox/bridges/

# ── Install entrypoint ───────────────────────────────────────────────
COPY entrypoint.sh /usr/local/bin/medical-start
RUN chmod +x /usr/local/bin/medical-start

# ── Fix ownership ────────────────────────────────────────────────────
RUN chown -R sandbox:sandbox /sandbox/models /sandbox/data /sandbox/bridges

ENTRYPOINT ["/bin/bash"]
