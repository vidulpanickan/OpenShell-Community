/**
 * NeMoClaw DevX Extension
 *
 * Injects into the OpenClaw UI:
 *   1. A green "Deploy DGX Spark/Station" CTA button in the topbar
 *   2. A "NeMoClaw" collapsible nav group with Policy, Inference Routes,
 *      and API Keys pages
 *   3. A model selector wired to NVIDIA endpoints
 *
 * Operates purely as an overlay — no original OpenClaw source files are modified.
 */

import "./styles.css";
import { injectButton } from "./deploy-modal.ts";
import { injectNavGroup, activateNemoPage, watchOpenClawNavClicks } from "./nav-group.ts";
import { injectModelSelector, watchChatCompose } from "./model-selector.ts";
import { ingestKeysFromUrl, DEFAULT_MODEL, resolveApiKey, isKeyConfigured } from "./model-registry.ts";
import { waitForStableConnection } from "./gateway-bridge.ts";
import { syncKeysToProviders } from "./api-keys-page.ts";

const STABLE_CONNECTION_WINDOW_MS = 1_500;
const INITIAL_CONNECTION_TIMEOUT_MS = 20_000;
const EXTENDED_CONNECTION_TIMEOUT_MS = 90_000;
const PAIRING_STATUS_POLL_MS = 500;
const PAIRING_REARM_INTERVAL_MS = 4_000;
const PAIRING_RELOAD_FLAG = "nemoclaw:pairing-bootstrap-recovery-reload";

interface PairingBootstrapState {
  status?: string;
  approvedCount?: number;
  active?: boolean;
  lastApprovalDeviceId?: string;
  lastError?: string;
}

function isPairingTerminal(state: PairingBootstrapState | null): boolean {
  if (!state) return false;
  if (state.active) return false;
  return state.status === "approved" || state.status === "paired" || state.status === "timeout" || state.status === "error";
}

function isPairingRecoveryEligible(state: PairingBootstrapState | null): boolean {
  if (!state) return false;
  return state.status === "approved" || state.status === "approved-pending-settle" || state.status === "paired";
}

function inject(): boolean {
  const hasButton = injectButton();
  const hasNav = injectNavGroup();
  return hasButton && hasNav;
}

/**
 * Delegated click handler for [data-nemoclaw-goto] links embedded in
 * error messages (deploy modal, model selector banners). Navigates to
 * the target NeMoClaw page without a full page reload.
 */
function watchGotoLinks() {
  document.addEventListener("click", (e) => {
    const link = (e.target as HTMLElement).closest<HTMLElement>("[data-nemoclaw-goto]");
    if (!link) return;
    e.preventDefault();
    const pageId = link.dataset.nemoclawGoto;
    if (pageId) activateNemoPage(pageId);
  });
}

/**
 * Insert a full-screen loading overlay that covers the OpenClaw UI while the
 * gateway connects and auto-pairs the device.  The overlay is styled via
 * styles.css and is automatically faded out once `data-nemoclaw-ready` is set
 * on <body>.  We remove it from the DOM after the CSS transition completes.
 */
function showConnectOverlay(): void {
  if (document.querySelector(".nemoclaw-connect-overlay")) return;
  const overlay = document.createElement("div");
  overlay.className = "nemoclaw-connect-overlay";
  overlay.setAttribute("aria-live", "polite");
  overlay.innerHTML =
    '<div class="nemoclaw-connect-overlay__spinner"></div>' +
    '<div class="nemoclaw-connect-overlay__text">Auto-approving device pairing. Hang tight...</div>';
  document.body.prepend(overlay);
}

function setConnectOverlayText(text: string): void {
  const textNode = document.querySelector<HTMLElement>(".nemoclaw-connect-overlay__text");
  if (textNode) textNode.textContent = text;
}

function revealApp(): void {
  document.body.setAttribute("data-nemoclaw-ready", "");
  const overlay = document.querySelector(".nemoclaw-connect-overlay");
  if (overlay) {
    overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
    setTimeout(() => overlay.remove(), 600);
  }
}

function shouldAllowRecoveryReload(): boolean {
  try {
    return sessionStorage.getItem(PAIRING_RELOAD_FLAG) !== "1";
  } catch {
    return true;
  }
}

function markRecoveryReloadUsed(): void {
  try {
    sessionStorage.setItem(PAIRING_RELOAD_FLAG, "1");
  } catch {
    // ignore storage failures
  }
}

async function fetchPairingBootstrapState(method: "GET" | "POST"): Promise<PairingBootstrapState | null> {
  try {
    const res = await fetch("/api/pairing-bootstrap", { method });
    if (!res.ok) return null;
    return (await res.json()) as PairingBootstrapState;
  } catch {
    return null;
  }
}

function getOverlayTextForPairingState(state: PairingBootstrapState | null): string | null {
  switch (state?.status) {
    case "armed":
      return "Preparing device pairing bootstrap...";
    case "pending":
      return "Waiting for device pairing request...";
    case "approving":
      return "Approving device pairing...";
    case "approved-pending-settle":
      return "Device pairing approved. Finalizing dashboard...";
    case "paired":
      return "Device paired. Finalizing dashboard...";
    case "approved":
      return "Device pairing approved. Opening dashboard...";
    case "timeout":
      return "Pairing bootstrap timed out. Opening dashboard...";
    case "error":
      return "Pairing bootstrap hit an error. Opening dashboard...";
    default:
      return null;
  }
}

function bootstrap() {
  console.info("[NeMoClaw] pairing bootstrap: start");
  showConnectOverlay();
  void fetchPairingBootstrapState("POST");

  let pairingPollTimer = 0;
  let stopped = false;
  let dashboardStable = false;
  let latestPairingState: PairingBootstrapState | null = null;
  let lastPairingStartAt = Date.now();

  const stopPairingPoll = () => {
    stopped = true;
    if (pairingPollTimer) window.clearTimeout(pairingPollTimer);
  };

  const pollPairingState = async () => {
    if (stopped) return null;
    const state = await fetchPairingBootstrapState("GET");
    latestPairingState = state;
    const text = getOverlayTextForPairingState(state);
    if (text) setConnectOverlayText(text);

    if (
      !stopped &&
      !dashboardStable &&
      state &&
      !state.active &&
      Date.now() - lastPairingStartAt >= PAIRING_REARM_INTERVAL_MS
    ) {
      const rearmed = await fetchPairingBootstrapState("POST");
      if (rearmed) {
        latestPairingState = rearmed;
        lastPairingStartAt = Date.now();
        const rearmedText = getOverlayTextForPairingState(rearmed);
        if (rearmedText) setConnectOverlayText(rearmedText);
      }
    }

    pairingPollTimer = window.setTimeout(pollPairingState, PAIRING_STATUS_POLL_MS);
    return state;
  };

  void pollPairingState();

  const waitForDashboardReadiness = async (timeoutMs: number, overlayText: string) => {
    setConnectOverlayText(overlayText);
    await waitForStableConnection(STABLE_CONNECTION_WINDOW_MS, timeoutMs);
  };

  const handlePairingTerminalWithoutStableConnection = async (reason: string) => {
    const state = latestPairingState || await fetchPairingBootstrapState("GET");
    const status = state?.status || "unknown";
    if (isPairingRecoveryEligible(state) && shouldAllowRecoveryReload()) {
      console.warn(`[NeMoClaw] pairing bootstrap: ${reason}; pairing=${status}; forcing one recovery reload`);
      stopPairingPoll();
      markRecoveryReloadUsed();
      setConnectOverlayText("Pairing succeeded. Recovering dashboard...");
      window.setTimeout(() => window.location.reload(), 750);
      return true;
    }
    if (isPairingTerminal(state)) {
      console.warn(`[NeMoClaw] pairing bootstrap: ${reason}; pairing=${status}; revealing app without further delay`);
      stopPairingPoll();
      revealApp();
      return true;
    }
    return false;
  };

  waitForDashboardReadiness(
    INITIAL_CONNECTION_TIMEOUT_MS,
    "Auto-approving device pairing. Hang tight...",
  )
    .catch(async () => {
      console.warn("[NeMoClaw] pairing bootstrap: initial dashboard readiness check timed out; extending wait");
      if (await handlePairingTerminalWithoutStableConnection("initial readiness timed out")) {
        return;
      }
      return waitForDashboardReadiness(
        EXTENDED_CONNECTION_TIMEOUT_MS,
        "Still waiting for device pairing approval...",
      );
    })
    .then(() => {
      dashboardStable = true;
      console.info("[NeMoClaw] pairing bootstrap: reveal app");
      stopPairingPoll();
      setConnectOverlayText("Device pairing approved. Opening dashboard...");
      revealApp();
    })
    .catch(async () => {
      if (await handlePairingTerminalWithoutStableConnection("extended readiness timed out")) {
        return;
      }
      const state = latestPairingState || await fetchPairingBootstrapState("GET");
      const status = state?.status || "unknown";
      console.warn(`[NeMoClaw] pairing bootstrap: readiness timed out; revealing app anyway (status=${status})`);
      stopPairingPoll();
      revealApp();
    });

  const keysIngested = ingestKeysFromUrl();

  watchOpenClawNavClicks();
  watchChatCompose();
  watchGotoLinks();

  const defaultKey = resolveApiKey(DEFAULT_MODEL.keyType);
  if (keysIngested || isKeyConfigured(defaultKey)) {
    syncKeysToProviders().catch((e) =>
      console.warn("[NeMoClaw] bootstrap provider key sync failed:", e),
    );
  }

  if (inject()) {
    injectModelSelector();
    return;
  }

  const observer = new MutationObserver(() => {
    if (inject()) {
      injectModelSelector();
      observer.disconnect();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 30_000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
