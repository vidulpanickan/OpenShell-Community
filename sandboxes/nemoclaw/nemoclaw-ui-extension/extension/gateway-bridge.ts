/**
 * NeMoClaw DevX — Gateway Bridge
 *
 * Discovers the OpenClaw app element's GatewayBrowserClient and exposes
 * helpers for sending config.patch RPCs without importing any openclaw internals.
 */

interface GatewayClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

interface ConfigSnapshot {
  hash?: string;
  [key: string]: unknown;
}

const CONNECTION_POLL_INTERVAL_MS = 200;
const BLOCKING_GATEWAY_MESSAGE_RE = /(pairing required|origin not allowed)/i;

/**
 * Returns the live GatewayBrowserClient from the <openclaw-app> element,
 * or null if the app hasn't connected yet.
 */
export function getClient(): GatewayClient | null {
  const app = document.querySelector("openclaw-app") as
    | (HTMLElement & { client?: GatewayClient | null })
    | null;
  return app?.client ?? null;
}

/**
 * Wait until the gateway client is available, up to timeoutMs.
 */
export function waitForClient(timeoutMs = 15_000): Promise<GatewayClient> {
  return new Promise((resolve, reject) => {
    const existing = getClient();
    if (existing) {
      resolve(existing);
      return;
    }

    const start = Date.now();
    const interval = setInterval(() => {
      const client = getClient();
      if (client) {
        clearInterval(interval);
        resolve(client);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error("Timed out waiting for OpenClaw gateway client"));
      }
    }, CONNECTION_POLL_INTERVAL_MS);
  });
}

/**
 * Send a config.patch RPC to merge a partial config into the running configuration.
 *
 * 1. Calls config.get to obtain the current baseHash
 * 2. Calls config.patch with the serialised patch + baseHash
 *
 * Throws on gateway errors so callers can surface them to the user.
 */
export async function patchConfig(patch: Record<string, unknown>): Promise<void> {
  const client = getClient();
  if (!client) {
    throw new Error("OpenClaw gateway not connected");
  }

  const snapshot = await client.request<ConfigSnapshot>("config.get", {});
  const baseHash = snapshot?.hash;

  const result = await client.request<{ ok?: boolean }>("config.patch", {
    raw: JSON.stringify(patch),
    ...(baseHash ? { baseHash } : {}),
  });

  if (result && typeof result === "object" && "ok" in result && !result.ok) {
    throw new Error("config.patch was rejected by the server");
  }
}

/**
 * Check whether the <openclaw-app> element reports `connected === true`.
 */
export function isAppConnected(): boolean {
  const app = document.querySelector("openclaw-app") as
    | (HTMLElement & { connected?: boolean })
    | null;
  return app?.connected === true;
}

function collectVisibleText(root: ParentNode | ShadowRoot | null): string {
  if (!root) return "";
  const chunks: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);

  let node: Node | null = walker.currentNode;
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text) chunks.push(text);
    } else if (node instanceof Element && node.shadowRoot) {
      const shadowText = collectVisibleText(node.shadowRoot);
      if (shadowText) chunks.push(shadowText);
    }
    node = walker.nextNode();
  }

  return chunks.join(" ");
}

export function hasBlockingGatewayMessage(): boolean {
  const app = document.querySelector("openclaw-app") as (HTMLElement & { shadowRoot?: ShadowRoot | null }) | null;
  if (!app) return false;
  const text = `${collectVisibleText(app)} ${collectVisibleText(app.shadowRoot ?? null)}`;
  return BLOCKING_GATEWAY_MESSAGE_RE.test(text);
}

/**
 * Wait for the gateway to reconnect after a restart (e.g. after config.patch).
 *
 * Resolves when the app is connected again, or rejects after timeoutMs.
 */
export function waitForReconnect(timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isAppConnected()) {
      resolve();
      return;
    }

    const start = Date.now();
    const interval = setInterval(() => {
      if (isAppConnected()) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error("Timed out waiting for gateway to reconnect"));
      }
    }, CONNECTION_POLL_INTERVAL_MS);
  });
}

/**
 * Wait until the app remains connected for a continuous stability window.
 *
 * This helps distinguish "socket connected for a moment" from "dashboard is
 * actually ready to be revealed after pairing/bootstrap settles".
 */
export function waitForStableConnection(
  stableForMs = 3_000,
  timeoutMs = 15_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let healthySince = 0;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      const now = Date.now();

      if (!isAppConnected() || hasBlockingGatewayMessage()) {
        healthySince = 0;
      } else {
        const client = getClient();
        if (!client) {
          healthySince = 0;
        } else {
          try {
            await client.request("status", {});
            if (!healthySince) healthySince = now;
            if (now - healthySince >= stableForMs) {
              cancelled = true;
              resolve();
              return;
            }
          } catch {
            healthySince = 0;
          }
        }
      }

      if (now - start > timeoutMs) {
        cancelled = true;
        reject(new Error("Timed out waiting for stable operational gateway connection"));
        return;
      }

      window.setTimeout(() => {
        void tick();
      }, CONNECTION_POLL_INTERVAL_MS);
    };

    void tick();
  });
}
