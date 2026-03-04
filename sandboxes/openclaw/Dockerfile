# syntax=docker/dockerfile:1.4

# SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# OpenClaw sandbox image for NemoClaw
#
# Builds on the community base sandbox and adds OpenClaw.
# Build:  docker build -t nemoclaw-openclaw --build-arg BASE_IMAGE=nemoclaw-base .
# Run:    nemoclaw sandbox create --from openclaw

ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw-community/sandboxes/base:latest
FROM ${BASE_IMAGE}

USER root

# Install OpenClaw CLI
RUN npm install -g openclaw

# policy.yaml is automatically copied by the base image ONBUILD directive

# Copy the OpenClaw startup helper
COPY openclaw-start.sh /usr/local/bin/openclaw-start
RUN chmod +x /usr/local/bin/openclaw-start

# Create OpenClaw workspace
RUN mkdir -p /sandbox/.openclaw && \
    chown -R sandbox:sandbox /sandbox/.openclaw

USER sandbox

ENTRYPOINT ["/bin/bash"]
