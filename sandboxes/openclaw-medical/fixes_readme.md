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

## Fix 7: Add Landlock protection for .openclaw directories (CRITICAL)

**Problem:** NemoClaw's upstream policy explicitly protects `/sandbox/.openclaw` and `/sandbox/.openclaw-data` as `read_only`. Medical's policy was missing this, allowing a compromised agent to modify the auth token in `openclaw.json`.

**Fix:** Added both paths to `filesystem_policy.read_only` in `policy.yaml`.

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

---

## Round 2 Fixes (10-agent + 6-agent + 3-agent review)

### Fix 8: Revert ENTRYPOINT to `/bin/bash`

**Problem:** Changed ENTRYPOINT to `/usr/local/bin/medical-start` but this breaks
OpenShell's model. The `-- command` pattern runs via SSH exec, not as the container
entrypoint. PID 1 is always the `openshell-sandbox` supervisor binary (injected by
the gateway via Kubernetes pod spec override). The Dockerfile's ENTRYPOINT is
irrelevant — the supervisor overrides it.

**Fix:** Reverted to `ENTRYPOINT ["/bin/bash"]`. The `-- medical-start` runs via
SSH exec after the sandbox reaches Ready state. No `exec /bin/bash -l` needed.

### Fix 9: Add `dangerouslyDisableDeviceAuth: true` to gateway config

**Problem:** Device pairing was required on every browser connection. NemoClaw's
Dockerfile sets this flag to skip pairing entirely.

**Fix:** Added `'dangerouslyDisableDeviceAuth': True` to the Python config patch
in `openclaw-nvidia-start.sh` (line 110). This is consumed by the OpenClaw gateway
binary and eliminates the pairing requirement.

### Fix 10: Increase execFile timeout from 5s to 15s

**Problem:** The auto-pairer's `execOpenClaw()` had a 5s timeout. The `openclaw`
CLI needs >5s to fail connecting to the gateway and fall back to local mode.
Commands were being killed before producing output, causing 32+ errors.

**Fix:** Changed timeout from 5000 to 15000 in `policy-proxy.js` line 123.

### Fix 11: Fix JSON parsing for mixed CLI output

**Problem:** `openclaw devices list --json` outputs banner text and diagnostic
messages before the JSON payload. `JSON.parse()` fails on the mixed output,
silently returning empty device lists (`pending: 0`).

**Fix:** Updated `parseJsonBody()` in `policy-proxy.js` to extract JSON from
mixed output by finding the first `{` or `[` and parsing from there.

### Fix 12: Add missing Discord CDN domains

**Problem:** Discord uses `cdn.discord.com` and `media.discordapp.net` for
avatars and attachments. Missing from network policy.

**Fix:** Added both domains to the `discord` network policy in `policy.yaml`.

### Fix 13: Wrap `source openclaw-nvidia-start` with `set +e`

**Problem:** `openclaw-nvidia-start.sh` has `set -euo pipefail` which could abort
the entrypoint if any command fails (e.g., API key injection under Landlock).

**Fix:** Added `set +e` before and `set -e` after the source call. Note: the
sourced script's own `set -euo pipefail` re-enables `-e`, so this is best-effort.
This matches how all other openclaw sandboxes work.

### Fix 14: Combine pip install into single Docker layer

**Problem:** Two separate `RUN pip install` commands create two layers, increasing
image size unnecessarily.

**Fix:** Combined into single `RUN` with `&&` chaining.

### Fix 15: Remove `.openclaw` from Landlock read_only

**Problem:** Adding `/sandbox/.openclaw` to `read_only` (Fix 7) blocked the
auto-pairer from writing device approval state.

**Fix:** Removed both `/sandbox/.openclaw` and `/sandbox/.openclaw-data` from
`read_only`. NemoClaw-style immutable/writable split deferred to future_updates.md.

---

## Round 2 Architecture Findings (no fix needed)

- **PID 1 is the `openshell-sandbox` supervisor**, not `/bin/bash`. The Dockerfile's
  ENTRYPOINT is overridden by the gateway via Kubernetes pod spec injection.
- **`-- medical-start` runs via SSH exec** after the sandbox reaches Ready state,
  not as the container's PID 1 command.
- **Container stays alive** via the supervisor's long-lived SSH server and
  `sleep infinity` default entrypoint child. Background processes (`nohup gateway`,
  `nohup policy-proxy`) survive the SSH session closing.
- **No `exec /bin/bash -l` needed** at the end of start scripts. This matches
  how `openclaw-nvidia-start.sh` and all other sandbox start scripts work.

---

## NEED TO FIX ASAP

### Issue A: Downgrade OpenClaw to v2026.3.8

**Problem:** `dangerouslyDisableDeviceAuth` is broken in OpenClaw v2026.3.11
(upstream issue #44485). The flag requires both `dangerouslyDisableDeviceAuth: true`
AND `sharedAuthOk: true`, but `sharedAuthOk` is false on HTTP deployments,
so the bypass is silently ignored. Result: device pairing is always required.

**Fix:** Added `RUN npm install -g openclaw@2026.3.8` to Dockerfile to override
the v2026.3.11 from the parent image. v2026.3.8 is the last version where the
flag works correctly.

### Issue B: Double medical-start causes token mismatch

**Problem:** Running `medical-start` twice starts TWO gateway processes with
DIFFERENT auth tokens. The browser gets the first token, but the second gateway
serves requests → `token_mismatch` and `device_token_mismatch` errors.

**Fix:** Added `pkill -f "openclaw gateway"` and `pkill -f "policy-proxy"` at the
start of entrypoint.sh before launching new processes.

### Issue C: Policy-proxy.js fixes not deployed

**Problem:** The timeout (5s→15s) and JSON parsing fixes in policy-proxy.js were
committed locally but not pushed to the remote server. The remote was running
the old code with 5s timeout and naive JSON.parse.

**Fix:** All changes pushed and image rebuilt.

---

## 20-Agent Review Findings (Round 3)

### Issue D: Upgrade OpenClaw v2026.3.8 → v2026.3.13 (CRITICAL)

**Problem:** v2026.3.8 has a HIGH severity vulnerability (GHSA-5wcw-8jjv-m286,
CVSS 8.1 — WebSocket origin bypass allowing privilege escalation to operator.admin).
v2026.3.13 fixes this vulnerability AND the dangerouslyDisableDeviceAuth bug.

**Fix:** Changed `npm install -g openclaw@2026.3.8` to `openclaw@2026.3.13`.

**Note:** v2026.3.13 has a minor regression (#47640 — CLI WS commands get "missing
scope: operator.read" on loopback gateway connections). This does NOT affect the
core gateway + Control UI workflow.

### Issue E: Telegram/Discord bridges are non-functional (PRE-EXISTING)

**Problem:** Both bridges call `POST /api/v1/chat` on the OpenClaw gateway, but
this endpoint **does not exist**. OpenClaw is a WebSocket gateway, not a REST chat
API. The bridges were never functional — this is not a regression from our changes.

**Status:** Deferred. Bridges need to be rewritten to use OpenClaw's WebSocket API
or a custom REST wrapper. Documented in future_updates.md.

### Issue F: Bridge status echo line shows "none" when both tokens set

**Problem:** The shell expansion on the "Bridges:" output line was incorrect.

**Fix:** Replaced with simple variable: `_bridges="${T:+telegram }${D:+discord }"`
then `echo "${_bridges:-none}"`.

### 20-Agent Team Summary

| Team | Focus | Result |
|------|-------|--------|
| Team 1 (Build) | Dockerfile validation | ALL PASS |
| Team 2 (Startup) | Entrypoint flow | PASS (minor echo bug fixed) |
| Team 3 (Pairing) | Device auth + version | UPGRADE TO v2026.3.13 |
| Team 4 (Security) | Policies + credentials | ALL PASS (minor: /usr/bin/glab dormant) |
| Team 5 (E2E) | Full journey | PASS except bridges (pre-existing issue) |
