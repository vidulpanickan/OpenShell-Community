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

### Install Docker

Docker must be running before you start. If you don't have it:

**Mac:** Download [Docker Desktop](https://www.docker.com/products/docker-desktop/) and start the app.

**Linux:**

```bash
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
newgrp docker
```

Verify it's running: `docker info`

If `docker info` shows a permission error, log out and log back in, then try again.

**Servers with 8GB RAM or less** — add swap space to prevent out-of-memory errors during setup:

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### Install OpenShell

```bash
curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh
```

If you see a message saying the install path is not on your PATH, run:

```bash
export PATH="$HOME/.local/bin:$PATH"
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc   # or ~/.zshrc on Mac
```

Verify it's installed: `openshell --version`

### Start the OpenShell gateway

This is a one-time step that creates the local cluster (takes a minute or two):

```bash
openshell gateway start
```

Wait for it to finish. You can check it's running with `openshell gateway status`.

### Get an inference provider API key

You need at least one API key to power the AI agent. Pick one:

| Provider | How to get a key | Environment variable |
|----------|-----------------|---------------------|
| **NVIDIA** | Go to https://build.nvidia.com → sign in → API Key | `NVIDIA_API_KEY` |
| **Anthropic (Claude)** | Go to https://console.anthropic.com → API Keys → Create Key | `ANTHROPIC_API_KEY` |
| **OpenAI (ChatGPT)** | Go to https://platform.openai.com/api-keys → Create new secret key | `OPENAI_API_KEY` |

You can use any combination of these. You can also switch between them at any time
after the sandbox is running (see [Switching Inference Providers](#switching-inference-providers)).

## Quick Start

### 1. Clone the repo

```bash
git clone https://github.com/vidulpanickan/OpenShell-Community.git
cd OpenShell-Community/sandboxes/openclaw-medical
```

### 2. Create a provider and configure inference

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

### 3. Create the sandbox

```bash
# OpenShell builds the image and loads it automatically
openshell sandbox create --name medical \
    --from ./ \
    --forward 18789 \
    -- medical-start
```

The gateway, inference routing, and model downloads all start automatically.
`CHAT_UI_URL` defaults to `http://127.0.0.1:18789`. Inference credentials are
configured via `openshell provider create` (step 2 above), not environment variables.

### 4. Verify it's running

```bash
openshell sandbox connect medical
cat /tmp/gateway.log
```

You should see `[gateway] listening on ws://127.0.0.1:18788`. Exit with `exit`.

### Remote access (Digital Ocean, AWS, etc.)

If OpenShell is running on a remote server, use an SSH tunnel from your laptop:

```bash
ssh -N -L 18789:127.0.0.1:18789 user@your-server-ip
```

Then open `http://127.0.0.1:18789/` in your local browser.

The sandbox works fine without any messaging bridges. You can add Telegram or
Discord bridges later without recreating the sandbox — just connect and start the bridge:

```bash
openshell sandbox connect medical

# Inside the sandbox:
export TELEGRAM_BOT_TOKEN="your-token"
/sandbox/.venv/bin/python /sandbox/bridges/telegram-bridge.py &
```

For step-by-step instructions on creating the bots and getting tokens, see
**[MESSAGING_SETUP.md](MESSAGING_SETUP.md)**.

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
| `CHAT_UI_URL` | No | URL where the chat UI is accessed (default: `http://127.0.0.1:18789`) |
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
