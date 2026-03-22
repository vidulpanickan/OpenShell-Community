# openclaw-medical: Fixes Required

Cross-checked against OpenShell, NemoClaw, and OpenShell-Community codebases by 4 independent review agents.

---

## CRITICAL Fixes

### 1. Dockerfile: Missing `USER sandbox` before ENTRYPOINT

**Problem:** The Dockerfile switches to `USER root` (line 32) for system installs but never switches back. The container runs as root, breaking OpenShell's entire security model.

**OpenShell alignment:** All sandbox images in the hierarchy end with `USER sandbox`:
- `base/Dockerfile` line 144: `USER sandbox`
- `openclaw/Dockerfile` line 32: `USER sandbox`
- `openclaw-nvidia/Dockerfile`: inherits `USER sandbox` from openclaw
- `openclaw-medical/Dockerfile`: **MISSING** — runs as root

**Impact:**
- Landlock filesystem restrictions are bypassed (root can read/write anything)
- seccomp BPF process filtering is weakened
- OpenClaw files initialized as root → policy-proxy can't approve devices → **pairing fails**
- Violates OpenShell's defense-in-depth security model

**Fix:** Add `USER sandbox` before `ENTRYPOINT ["/bin/bash"]`

---

### 2. Dockerfile: Wrong venv ownership after pip install

**Problem:** pip packages are installed as root during Docker build:
```dockerfile
USER root
RUN /sandbox/.venv/bin/pip install --no-cache-dir torch ...
RUN /sandbox/.venv/bin/pip install --no-cache-dir transformers ...
```

The venv files end up owned by root. At runtime, the sandbox user may not be able to write to the venv (e.g., for cached model compilation or runtime imports).

**OpenShell alignment:** The base image creates `/sandbox/.venv` as sandbox user. Medical overrides ownership by installing as root without restoring.

**Fix:** Add `chown -R sandbox:sandbox /sandbox/.venv` after pip installs.

---

### 3. Dockerfile: Missing `/sandbox/models` directory

**Problem:** The `chown` command doesn't include `/sandbox/models`. The directory is created at runtime by `download-models.py` via `os.makedirs()`, but it's not pre-created with correct ownership.

**Fix:** Add `mkdir -p /sandbox/models` and include in chown.

---

### 4. entrypoint.sh: CHAT_UI_URL has no default

**Problem:** `openclaw-nvidia-start.sh` requires `CHAT_UI_URL` and exits with an error if it's missing. The README's `-- env CHAT_UI_URL=... medical-start` syntax doesn't work because OpenShell's SSH supervisor runs `env_clear()` and only injects a fixed set of environment variables (OPENSHELL_SANDBOX, HOME, USER, SHELL, PATH, TERM, proxy vars).

**OpenShell alignment:** The SSH supervisor in `openshell-sandbox/src/ssh.rs` (line 663) explicitly clears the environment. Custom env vars cannot be passed via `-- env KEY=VAL` — the `env` command runs but its variables are not inherited by the sourced scripts.

**Fix:** Default `CHAT_UI_URL` in entrypoint.sh:
```bash
export CHAT_UI_URL="${CHAT_UI_URL:-http://127.0.0.1:18789}"
```

---

## HIGH Fixes

### 5. policy.yaml: Stale python3.12 reference

**Problem:** The nvidia network policy references `/usr/bin/python3.12` but the base image installs Python 3.13 via `uv`. The path doesn't exist in the container.

**OpenShell alignment:** Policies should reference actual binary paths in the image. The correct patterns are already present: `/sandbox/.venv/bin/python*` and `/sandbox/.uv/python/**`.

**Fix:** Remove `{ path: /usr/bin/python3.12 }` from the nvidia policy section.

---

### 6. README.md: Simplify sandbox create command

**Problem:** The documented create command uses `-- env CHAT_UI_URL=... medical-start` which doesn't work (see fix #4 above).

**Fix:** Simplify to:
```bash
openshell sandbox create --name medical --from ./ --forward 18789 -- medical-start
```

---

## Security Alignment Summary

| OpenShell Security Layer | Current (broken) | After fixes |
|--------------------------|-------------------|-------------|
| **Filesystem (Landlock)** | Bypassed (root) | Enforced (sandbox user) |
| **Process (seccomp BPF)** | Weakened (root) | Enforced (sandbox user) |
| **Network (OPA/proxy)** | Working | Working |
| **Inference (routing)** | Working | Working |
| **Device pairing** | Failing (root ownership) | Should work (sandbox ownership) |

---

## Consolidated Dockerfile Fix

```dockerfile
# After all RUN commands as root:

# Fix ownership for all sandbox-writable paths
RUN mkdir -p /sandbox/models && \
    chown -R sandbox:sandbox /sandbox/.venv /sandbox/data /sandbox/models \
                             /sandbox/bridges /sandbox/download-models.py

# Switch back to unprivileged user (required by OpenShell security model)
USER sandbox

ENTRYPOINT ["/bin/bash"]
```

---

## What was verified as correct (no changes needed)

- Network policies: All Telegram, Discord, HuggingFace, PyPI endpoints correctly scoped
- Binary access control: `/usr/bin/node` correctly excluded from external APIs
- Policy-proxy.js: Auto-pairing state machine is correct (failure was due to root ownership)
- Inference routing: `inference.local` properly configured
- Bridge scripts: Correct dependencies and API usage
- Model download: HF_HUB_ENABLE_XET=0 fix working (135MB/s downloads)
- Database setup: Correctly created at build time
- Dockerfile inheritance: All layers from base → openclaw → openclaw-nvidia properly inherited
