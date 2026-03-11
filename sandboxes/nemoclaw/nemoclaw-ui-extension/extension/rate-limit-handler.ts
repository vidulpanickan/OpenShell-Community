/**
 * NeMoClaw DevX — Rate Limit Handler
 *
 * Detects free-tier rate limiting (40 req/min on build.nvidia.com) via
 * two complementary strategies:
 *
 *   1. WebSocket interception — wraps the WebSocket constructor before
 *      OpenClaw creates its gateway connection so we can monitor both
 *      outgoing sends (request counting) and incoming messages (error
 *      detection for 429 / rate-limit keywords).
 *
 *   2. Client-side budget tracking — maintains a rolling 60-second
 *      window of request timestamps to proactively warn users before
 *      they hit the limit.
 *
 * When the limit is approached or hit, a contextual banner is rendered
 * inside .chat-compose with a countdown timer and a model-specific CTA
 * to deploy a dedicated endpoint.
 */

import { ICON_ZAP, ICON_WARNING, ICON_CLOSE, ICON_LOADER } from "./icons.ts";
import { getModelDeployUrl, CURATED_MODELS, getCuratedByModelId } from "./model-registry.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RATE_LIMIT = 40;
const WINDOW_MS = 60_000;
const WARN_THRESHOLD = 36;

const RATE_LIMIT_PATTERNS = [
  "rate limit",
  "rate_limit",
  "ratelimit",
  "too many requests",
  "quota exceeded",
  "throttled",
  "429",
  "resource_exhausted",
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let requestTimestamps: number[] = [];
let rateLimitDetectedAt: number | null = null;
let retryAfterMs: number | null = null;
let bannerEl: HTMLElement | null = null;
let countdownInterval: ReturnType<typeof setInterval> | null = null;
let currentModelId: string = CURATED_MODELS[0]?.modelId ?? "";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RateLimitBudget {
  used: number;
  limit: number;
  remaining: number;
  resetsInMs: number;
}

export function getRateLimitBudget(): RateLimitBudget {
  pruneOldTimestamps();
  const used = requestTimestamps.length;
  const oldest = requestTimestamps[0];
  const resetsInMs = oldest ? Math.max(0, WINDOW_MS - (Date.now() - oldest)) : 0;
  return { used, limit: RATE_LIMIT, remaining: RATE_LIMIT - used, resetsInMs };
}

export function setCurrentModelId(modelId: string): void {
  currentModelId = modelId;
}

// ---------------------------------------------------------------------------
// WebSocket interception
//
// Must be called before OpenClaw creates its gateway WebSocket. We wrap
// the native WebSocket constructor to attach listeners on every new
// connection without modifying the caller's behavior.
// ---------------------------------------------------------------------------

export function initRateLimitHandler(): void {
  const NativeWebSocket = window.WebSocket;

  const WrappedWebSocket = function (
    this: WebSocket,
    url: string | URL,
    protocols?: string | string[],
  ): WebSocket {
    const ws: WebSocket = new NativeWebSocket(url, protocols);

    ws.addEventListener("message", onWebSocketMessage);

    const originalSend = ws.send.bind(ws);
    ws.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      recordOutgoingRequest(data);
      return originalSend(data);
    };

    return ws;
  } as unknown as typeof WebSocket;

  WrappedWebSocket.prototype = NativeWebSocket.prototype;
  WrappedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
  WrappedWebSocket.OPEN = NativeWebSocket.OPEN;
  WrappedWebSocket.CLOSING = NativeWebSocket.CLOSING;
  WrappedWebSocket.CLOSED = NativeWebSocket.CLOSED;

  window.WebSocket = WrappedWebSocket;
}

// ---------------------------------------------------------------------------
// Outgoing request tracking
// ---------------------------------------------------------------------------

function isLikelyChatRequest(data: unknown): boolean {
  if (typeof data !== "string") return false;
  try {
    const parsed = JSON.parse(data);
    if (parsed.method && typeof parsed.method === "string") {
      const m = parsed.method.toLowerCase();
      return m.includes("chat") || m.includes("generate") || m.includes("completion")
        || m.includes("prompt") || m.includes("send") || m.includes("message");
    }
    if (parsed.messages || parsed.prompt) return true;
  } catch {
    // Not JSON — could be a binary frame; skip
  }
  return false;
}

function recordOutgoingRequest(data: unknown): void {
  if (!isLikelyChatRequest(data)) return;

  const now = Date.now();
  requestTimestamps.push(now);
  pruneOldTimestamps();

  const budget = getRateLimitBudget();

  if (budget.remaining <= 0) {
    triggerRateLimitBanner(budget);
  } else if (budget.used >= WARN_THRESHOLD) {
    showWarningBanner(budget);
  }
}

function pruneOldTimestamps(): void {
  const cutoff = Date.now() - WINDOW_MS;
  while (requestTimestamps.length > 0 && requestTimestamps[0] < cutoff) {
    requestTimestamps.shift();
  }
}

// ---------------------------------------------------------------------------
// Incoming message analysis
// ---------------------------------------------------------------------------

function onWebSocketMessage(event: MessageEvent): void {
  if (typeof event.data !== "string") return;

  const lower = event.data.toLowerCase();
  const isRateLimited = RATE_LIMIT_PATTERNS.some((p) => lower.includes(p));
  if (!isRateLimited) return;

  let retryAfter: number | null = null;
  try {
    const parsed = JSON.parse(event.data);
    const errMsg = parsed?.error?.message || parsed?.message || parsed?.detail || "";
    if (typeof errMsg === "string" && RATE_LIMIT_PATTERNS.some((p) => errMsg.toLowerCase().includes(p))) {
      retryAfter = parseRetryAfter(parsed);
    } else {
      return;
    }
  } catch {
    // Raw text match is sufficient for non-JSON messages
  }

  rateLimitDetectedAt = Date.now();
  retryAfterMs = retryAfter ?? computeRetryFromBudget();
  triggerRateLimitBanner(getRateLimitBudget());
}

function parseRetryAfter(parsed: Record<string, unknown>): number | null {
  const headers = parsed.headers as Record<string, string> | undefined;
  const retryVal = headers?.["retry-after"] || headers?.["Retry-After"];
  if (retryVal) {
    const secs = parseInt(retryVal, 10);
    if (!isNaN(secs) && secs > 0) return secs * 1000;
  }
  return null;
}

function computeRetryFromBudget(): number {
  if (requestTimestamps.length === 0) return WINDOW_MS;
  const oldest = requestTimestamps[0];
  return Math.max(1000, WINDOW_MS - (Date.now() - oldest));
}

// ---------------------------------------------------------------------------
// Resolve deploy URL for the currently selected model
// ---------------------------------------------------------------------------

function resolveDeployUrl(): string {
  return getModelDeployUrl(currentModelId);
}

function resolveModelDisplayName(): string {
  const curated = getCuratedByModelId(currentModelId);
  return curated?.name ?? currentModelId;
}

// ---------------------------------------------------------------------------
// Banner rendering
// ---------------------------------------------------------------------------

function getChatCompose(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".chat-compose");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function dismissBanner(): void {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  if (bannerEl) {
    bannerEl.classList.add("nemoclaw-ratelimit-banner--dismiss");
    bannerEl.addEventListener("animationend", () => {
      bannerEl?.remove();
      bannerEl = null;
    }, { once: true });
    setTimeout(() => {
      bannerEl?.remove();
      bannerEl = null;
    }, 400);
  }
  rateLimitDetectedAt = null;
  retryAfterMs = null;
}

/**
 * Warning banner — shown when the user is approaching the rate limit
 * (>= 36/40 requests in the current window). Subtle amber style.
 */
function showWarningBanner(budget: RateLimitBudget): void {
  if (bannerEl?.classList.contains("nemoclaw-ratelimit-banner--limited")) return;
  if (bannerEl?.classList.contains("nemoclaw-ratelimit-banner--warning")) {
    updateWarningCount(budget);
    return;
  }

  const chatCompose = getChatCompose();
  if (!chatCompose) return;

  dismissBanner();

  const banner = document.createElement("div");
  banner.className = "nemoclaw-ratelimit-banner nemoclaw-ratelimit-banner--warning";
  banner.innerHTML = [
    `<span class="nemoclaw-ratelimit-banner__icon">${ICON_WARNING}</span>`,
    `<div class="nemoclaw-ratelimit-banner__body">`,
    `  <span class="nemoclaw-ratelimit-banner__text">`,
    `    Approaching free tier rate limit &mdash; `,
    `    <strong class="nemoclaw-ratelimit-banner__budget">${budget.used}/${budget.limit}</strong> requests this minute`,
    `  </span>`,
    `  <a class="nemoclaw-ratelimit-banner__deploy-link" href="${resolveDeployUrl()}" target="_blank" rel="noopener noreferrer">`,
    `    ${ICON_ZAP} Remove limits`,
    `  </a>`,
    `</div>`,
    `<button class="nemoclaw-ratelimit-banner__dismiss" type="button" aria-label="Dismiss">${ICON_CLOSE}</button>`,
  ].join("");

  banner.querySelector(".nemoclaw-ratelimit-banner__dismiss")?.addEventListener("click", dismissBanner);

  chatCompose.insertBefore(banner, chatCompose.firstChild);
  bannerEl = banner;

  scheduleWarningAutoHide();
}

function updateWarningCount(budget: RateLimitBudget): void {
  const budgetEl = bannerEl?.querySelector(".nemoclaw-ratelimit-banner__budget");
  if (budgetEl) budgetEl.textContent = `${budget.used}/${budget.limit}`;
}

function scheduleWarningAutoHide(): void {
  if (countdownInterval) clearInterval(countdownInterval);

  countdownInterval = setInterval(() => {
    const budget = getRateLimitBudget();
    if (budget.used < WARN_THRESHOLD) {
      dismissBanner();
    } else {
      updateWarningCount(budget);
    }
  }, 2000);
}

/**
 * Rate-limited banner — shown when a 429 is detected or the client-side
 * counter hits 40/40. Prominent style with countdown timer and deploy CTA.
 */
function triggerRateLimitBanner(budget: RateLimitBudget): void {
  const chatCompose = getChatCompose();
  if (!chatCompose) return;

  dismissBanner();

  const waitMs = retryAfterMs ?? computeRetryFromBudget();
  const endTime = Date.now() + waitMs;
  const deployUrl = resolveDeployUrl();
  const modelName = escapeHtml(resolveModelDisplayName());

  const banner = document.createElement("div");
  banner.className = "nemoclaw-ratelimit-banner nemoclaw-ratelimit-banner--limited";
  banner.innerHTML = [
    `<span class="nemoclaw-ratelimit-banner__icon">${ICON_WARNING}</span>`,
    `<div class="nemoclaw-ratelimit-banner__body">`,
    `  <span class="nemoclaw-ratelimit-banner__text">`,
    `    Free tier rate limit reached <span class="nemoclaw-ratelimit-banner__budget-inline">(${budget.used}/${budget.limit} req/min)</span>`,
    `  </span>`,
    `  <div class="nemoclaw-ratelimit-banner__countdown-row">`,
    `    <span class="nemoclaw-ratelimit-banner__countdown-icon">${ICON_LOADER}</span>`,
    `    <span class="nemoclaw-ratelimit-banner__countdown">You can send again in <strong class="nemoclaw-ratelimit-banner__timer">${formatSeconds(waitMs)}</strong></span>`,
    `  </div>`,
    `  <div class="nemoclaw-ratelimit-banner__bar">`,
    `    <div class="nemoclaw-ratelimit-banner__bar-fill"></div>`,
    `  </div>`,
    `  <a class="nemoclaw-ratelimit-banner__deploy-cta" href="${deployUrl}" target="_blank" rel="noopener noreferrer">`,
    `    ${ICON_ZAP}`,
    `    <span>`,
    `      <strong>Dedicated endpoint</strong>`,
    `      <span class="nemoclaw-ratelimit-banner__deploy-sub">Unlimited, private requests; ${modelName}</span>`,
    `    </span>`,
    `  </a>`,
    `</div>`,
    `<button class="nemoclaw-ratelimit-banner__dismiss" type="button" aria-label="Dismiss">${ICON_CLOSE}</button>`,
  ].join("");

  banner.querySelector(".nemoclaw-ratelimit-banner__dismiss")?.addEventListener("click", dismissBanner);

  const fill = banner.querySelector<HTMLElement>(".nemoclaw-ratelimit-banner__bar-fill");
  if (fill) {
    fill.style.transition = `width ${waitMs}ms linear`;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { fill.style.width = "100%"; });
    });
  }

  chatCompose.insertBefore(banner, chatCompose.firstChild);
  bannerEl = banner;

  countdownInterval = setInterval(() => {
    const remaining = Math.max(0, endTime - Date.now());
    const timerEl = banner.querySelector(".nemoclaw-ratelimit-banner__timer");
    if (timerEl) timerEl.textContent = formatSeconds(remaining);

    if (remaining <= 0) {
      transitionToReady(banner);
    }
  }, 250);
}

function transitionToReady(banner: HTMLElement): void {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }

  const countdownRow = banner.querySelector(".nemoclaw-ratelimit-banner__countdown-row");
  if (countdownRow) {
    countdownRow.innerHTML = `<span class="nemoclaw-ratelimit-banner__ready">Ready &mdash; you can send your message now</span>`;
  }

  banner.classList.remove("nemoclaw-ratelimit-banner--limited");
  banner.classList.add("nemoclaw-ratelimit-banner--ready");

  rateLimitDetectedAt = null;
  retryAfterMs = null;

  setTimeout(() => dismissBanner(), 5000);
}

function formatSeconds(ms: number): string {
  const secs = Math.ceil(ms / 1000);
  return `${secs}s`;
}
