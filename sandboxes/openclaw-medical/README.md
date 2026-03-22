# openclaw-medical

A secure OpenShell sandbox for medical AI workflows. Combines OpenClaw agent orchestration
with baked-in medical models, a SQLite database, and messaging bridges — all running inside
OpenShell's four-layer security model.

All LLM inference (NVIDIA, Claude, ChatGPT, Ollama) goes through `inference.local` routing.
The agent runtime has no direct access to external APIs. See [workflow_readme.md](workflow_readme.md)
for the complete security architecture.

## What's Included

| Component | Description |
|-----------|-------------|
| OpenClaw agent | AI agent orchestration (inherited from openclaw-nvidia) |
| inference.local routing | Secure LLM inference via proxy — supports NVIDIA, Claude, OpenAI, Ollama |
| Medical embedding model | `vectorranger/embeddinggemma-300m-medical-300k` baked in at `/sandbox/models/` |
| SQLite database | Medical schema at `/sandbox/data/medical.db` |
| Telegram bridge | Python bot that forwards messages to the agent |
| Discord bridge | Python bot that forwards messages to the agent |
| NeMoClaw DevX UI | Model selector and policy management (inherited from openclaw-nvidia) |

## Prerequisites

- [OpenShell](https://github.com/nvidia/openshell) installed and running
- Docker running
- At least one inference provider API key (NVIDIA, Anthropic, or OpenAI)

## Quick Start

### 1. Create a provider and configure inference

```bash
# Example: use NVIDIA
export NVIDIA_API_KEY="nvapi-..."
openshell provider create --name nvidia --type nvidia --from-existing
openshell inference set --provider nvidia --model moonshotai/kimi-k2.5

# Or use Claude
export ANTHROPIC_API_KEY="sk-ant-..."
openshell provider create --name claude --type anthropic --from-existing
openshell inference set --provider claude --model claude-sonnet-4-20250514

# Or use ChatGPT
export OPENAI_API_KEY="sk-..."
openshell provider create --name openai --type openai --from-existing
openshell inference set --provider openai --model gpt-4o
```

### 2. Build and create the sandbox

```bash
cd sandboxes/openclaw-medical

# Build the image
docker build -t openclaw-medical .

# Create the sandbox
openshell sandbox create --name medical \
    --from openclaw-medical \
    --forward 18789 \
    -- env CHAT_UI_URL=http://127.0.0.1:18789 \
           NVIDIA_INFERENCE_API_KEY="${NVIDIA_API_KEY}" \
           medical-start
```

### 3. (Optional) Start with messaging bridges

```bash
openshell sandbox create --name medical \
    --from openclaw-medical \
    --forward 18789 \
    -- env CHAT_UI_URL=http://127.0.0.1:18789 \
           NVIDIA_INFERENCE_API_KEY="${NVIDIA_API_KEY}" \
           TELEGRAM_BOT_TOKEN="your-bot-token" \
           DISCORD_BOT_TOKEN="your-bot-token" \
           medical-start
```

## Switching Inference Providers

Provider switching is a control-plane operation — no sandbox restart or code changes needed:

```bash
# Switch to a different provider (takes effect within 30 seconds)
openshell inference set --provider claude --model claude-sonnet-4-20250514
```

The agent continues calling `inference.local`. The proxy handles routing to the new backend.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CHAT_UI_URL` | Yes | URL where the chat UI is accessed |
| `NVIDIA_INFERENCE_API_KEY` | No | NVIDIA API key (injected into UI) |
| `NVIDIA_INTEGRATE_API_KEY` | No | NVIDIA integrate API key (injected into UI) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token — starts bridge if set |
| `DISCORD_BOT_TOKEN` | No | Discord bot token — starts bridge if set |
| `ALLOWED_CHAT_IDS` | No | Comma-separated Telegram chat IDs (all if unset) |
| `DISCORD_CHANNEL_IDS` | No | Comma-separated Discord channel IDs (all if unset) |

## Models

| Model | Path | Size | Purpose |
|-------|------|------|---------|
| embeddinggemma-300m-medical-300k | `/sandbox/models/medical-embedding/` | ~300M params | Medical document embeddings |

To add more models, edit `download-models.py` and rebuild the image.

## Database

SQLite database at `/sandbox/data/medical.db` with tables:

- `patients` — Patient records with external IDs
- `embeddings` — Document embeddings linked to patients
- `entities` — Extracted entities (type, value, confidence) linked to patients

## Security Model

This sandbox inherits the full OpenShell security model:

- **Filesystem**: Landlock restricts agent to `/sandbox/` (read-write) and system dirs (read-only)
- **Process**: seccomp blocks dangerous socket domains; agent runs as unprivileged `sandbox` user
- **Network**: All traffic goes through HTTP CONNECT proxy with OPA/Rego binary-endpoint binding
- **Inference**: All LLM calls go through `inference.local` — credentials never exposed to agent

The agent runtime (`/usr/bin/node`) has **no direct access** to NVIDIA, OpenAI, Anthropic,
Telegram, Discord, or HuggingFace APIs. Messaging bridges run as Python processes with
scoped access to their respective APIs only.

See [workflow_readme.md](workflow_readme.md) for the detailed security architecture.
