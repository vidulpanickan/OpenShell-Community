# openclaw-medical: Future Updates

## 1. Split ML dependencies to runtime install (Priority: High)

**Problem:** The current Docker image is ~3GB because PyTorch, transformers, and
sentence-transformers are baked in at build time. This causes the K3s image push
to get OOM-killed on 8GB servers.

**Solution:** Move ML pip installs from Dockerfile to a runtime `setup-ml.sh` script:
- Remove `torch`, `transformers`, `sentence-transformers`, `huggingface-hub` from Dockerfile
- Create `setup-ml.sh` that runs `pip install` on first startup (before model download)
- Packages persist in `/sandbox/.venv` across restarts
- Image drops to ~1.5GB, fits on 8GB servers

**Policy change needed:** Add `download.pytorch.org:443` to the PyPI network policy
(needed for the `--index-url https://download.pytorch.org/whl/cpu` torch install).

**Existing policies already cover:** `pypi.org`, `files.pythonhosted.org` (PyPI),
and all HuggingFace endpoints (model downloads).

## 2. Automated onboarding script (Priority: Medium)

NemoClaw has a 7-step interactive onboarding wizard with preflight checks
(Docker running, port availability, OpenShell installed, GPU detection).
openclaw-medical currently requires manual CLI commands per the README.

## 3. NemoClaw-style .openclaw directory split (Priority: High)

Currently `/sandbox/.openclaw` is fully writable. NemoClaw splits it into:
- `/sandbox/.openclaw` — **immutable config** (read-only under Landlock): `openclaw.json`
  with `chmod 444`, root-owned, protecting auth tokens and CORS settings
- `/sandbox/.openclaw-data` — **writable state** (read-write): sessions, workspace,
  agent state, device pairing data, symlinked from `.openclaw` subdirectories

This protects the config from agent tampering while allowing OpenClaw to write
state data. Requires mapping which subdirectories OpenClaw writes to for device
pairing, sessions, etc.

## 4. Add missing NemoClaw network policies (Priority: Low)

NemoClaw's upstream policy includes policies for `clawhub`, `openclaw_api`, and
`openclaw_docs` which medical does not have. These enable OpenClaw plugin
management and docs access from inside the sandbox.
