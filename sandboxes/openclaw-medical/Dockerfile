# syntax=docker/dockerfile:1.4

# SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# openclaw-medical sandbox image
#
# Builds on openclaw-nvidia (which provides inference.local routing, policy-proxy,
# and the NeMoClaw DevX UI extension) and adds:
#   - Medical embedding model (downloaded on first startup from HuggingFace)
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
#     -- medical-start

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
    torch --index-url https://download.pytorch.org/whl/cpu && \
    /sandbox/.venv/bin/pip install --no-cache-dir \
    transformers \
    sentence-transformers \
    huggingface-hub \
    python-telegram-bot \
    "discord.py>=2.0"

# ── Model download script (runs at first startup, not build time) ────
# Keeps the image small (~2.5GB instead of ~4.7GB) so it fits in
# memory during the K3s image push on 8GB servers.
COPY download-models.py /sandbox/download-models.py

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
# pip installs run as root, so restore sandbox ownership on the venv.
# Pre-create /sandbox/models for first-run model downloads.
RUN mkdir -p /sandbox/models && \
    chown -R sandbox:sandbox /sandbox/.venv /sandbox/data /sandbox/models \
                             /sandbox/bridges /sandbox/download-models.py

# ── Switch back to unprivileged user ───────────────────────────────
# Required by OpenShell's defense-in-depth security model.
USER sandbox

ENTRYPOINT ["/bin/bash"]
