/**
 * NeMoClaw DevX — Environment variables (Inference tab section)
 *
 * Builds the Environment variables form for the Inference page. Keys are stored in
 * localStorage and resolved at call time by model-registry.ts.
 */

import { ICON_EYE, ICON_EYE_OFF, ICON_CHECK, ICON_LOADER, ICON_CLOSE, ICON_PLUS, ICON_TRASH } from "./icons.ts";
import { getIntegrateApiKey, setIntegrateApiKey, isKeyConfigured } from "./model-registry.ts";
import { isPreviewMode } from "./preview-mode.ts";

const CUSTOM_KEYS_STORAGE_KEY = "nemoclaw:api-keys-custom";

function getCustomKeys(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CUSTOM_KEYS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function setCustomKeys(keys: Record<string, string>): void {
  localStorage.setItem(CUSTOM_KEYS_STORAGE_KEY, JSON.stringify(keys));
}

function setCustomKey(keyName: string, value: string): void {
  const keys = getCustomKeys();
  if (value) keys[keyName] = value;
  else delete keys[keyName];
  setCustomKeys(keys);
}

function removeCustomKey(keyName: string): void {
  const keys = getCustomKeys();
  delete keys[keyName];
  setCustomKeys(keys);
}

// ---------------------------------------------------------------------------
// Key field definitions
// ---------------------------------------------------------------------------

interface KeyFieldDef {
  id: string;
  label: string;
  description: string;
  placeholder: string;
  serverCredentialKey: string;
  get: () => string;
  set: (v: string) => void;
}

const KEY_FIELDS: KeyFieldDef[] = [
  {
    id: "integrate",
    label: "NVIDIA_API_KEY",
    description: "NVIDIA API key (e.g. Integrate). Get keys at build.nvidia.com.",
    placeholder: "Paste value",
    serverCredentialKey: "NVIDIA_API_KEY",
    get: getIntegrateApiKey,
    set: setIntegrateApiKey,
  },
];

// ---------------------------------------------------------------------------
// Sync localStorage keys to server-side provider credentials
// ---------------------------------------------------------------------------

interface ProviderSummary {
  name: string;
  type: string;
  credentialKeys: string[];
}

/**
 * Push all Environment variables (built-in + custom) to server-side providers whose
 * credential key matches. Used when saving keys from the Inference tab.
 */
export async function syncKeysToProviders(): Promise<void> {
  if (isPreviewMode()) return;
  const res = await fetch("/api/providers");
  if (!res.ok) throw new Error(`Failed to fetch providers: ${res.status}`);
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || "Failed to fetch providers");

  const providers: ProviderSummary[] = body.providers || [];
  const errors: string[] = [];
  const allKeyNames = getSectionCredentialKeyNames();

  for (const provider of providers) {
    for (const keyName of allKeyNames) {
      if (!provider.credentialKeys?.includes(keyName)) continue;
      const value = getSectionKeyValue(keyName);
      if (!isKeyConfigured(value)) continue;

      try {
        const updateRes = await fetch(`/api/providers/${encodeURIComponent(provider.name)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: provider.type,
            credentials: { [keyName]: value },
            config: {},
          }),
        });
        const updateBody = await updateRes.json();
        if (!updateBody.ok) {
          errors.push(`${provider.name}: ${updateBody.error || "update failed"}`);
        }
      } catch (err) {
        errors.push(`${provider.name}: ${err}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}

// ---------------------------------------------------------------------------
// Build Environment variables section for Inference tab
// ---------------------------------------------------------------------------

export function buildApiKeysSection(): HTMLElement {
  const section = document.createElement("div");
  section.className = "nemoclaw-inference-apikeys";

  const heading = document.createElement("div");
  heading.className = "nemoclaw-inference-apikeys__heading";
  heading.innerHTML = `<span class="nemoclaw-inference-apikeys__title">Environment variables</span>`;
  section.appendChild(heading);

  const intro = document.createElement("p");
  intro.className = "nemoclaw-inference-apikeys__intro";
  intro.textContent = "Env vars (e.g. API keys) used by providers. Values are synced to matching provider credentials. You can also set or override per-provider in the forms above.";
  intro.textContent = "Env vars (e.g. API keys) used by providers. Values are synced to matching provider credentials. You can also set or override per-provider in the forms above. X’ll be synced to matching providers. You can also enter or override keys per-provider in the forms above.";
  section.appendChild(intro);

  const form = document.createElement("div");
  form.className = "nemoclaw-key-form nemoclaw-inference-apikeys__form";

  const allKeyNames = getSectionCredentialKeyNames();
  for (const keyName of allKeyNames) {
    const field = KEY_FIELDS.find((f) => f.serverCredentialKey === keyName);
    const label = field ? field.label : keyName;
    form.appendChild(buildKeyRow(section, keyName, label, !!field));
  }

  const addKeyRow = document.createElement("div");
  addKeyRow.className = "nemoclaw-inference-apikeys__add-row";
  const addKeyBtn = document.createElement("button");
  addKeyBtn.type = "button";
  addKeyBtn.className = "nemoclaw-policy-add-small-btn";
  addKeyBtn.innerHTML = `${ICON_PLUS} Add variable`;
  addKeyBtn.addEventListener("click", () => {
    const existing = form.querySelector(".nemoclaw-inference-apikeys__add-form");
    if (existing) {
      existing.remove();
      return;
    }
    const addForm = buildAddKeyForm(section, form, addKeyRow);
    form.insertBefore(addForm, addKeyRow);
  });
  addKeyRow.appendChild(addKeyBtn);
  form.appendChild(addKeyRow);

  const actions = document.createElement("div");
  actions.className = "nemoclaw-key-actions";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "nemoclaw-key-save";
  saveBtn.textContent = "Save";

  const feedback = document.createElement("div");
  feedback.className = "nemoclaw-key-feedback";
  feedback.setAttribute("role", "status");

  actions.appendChild(saveBtn);
  actions.appendChild(feedback);
  form.appendChild(actions);
  section.appendChild(form);

  saveBtn.addEventListener("click", async () => {
    form.querySelectorAll<HTMLInputElement>("input[data-api-key-name]").forEach((input) => {
      const keyName = input.dataset.apiKeyName;
      if (keyName) setSectionKeyValue(keyName, input.value.trim());
    });

    feedback.className = "nemoclaw-key-feedback nemoclaw-key-feedback--saving";
    feedback.innerHTML = `${ICON_LOADER}<span>Syncing to providers\u2026</span>`;
    saveBtn.disabled = true;

    try {
      await syncKeysToProviders();
      feedback.className = "nemoclaw-key-feedback nemoclaw-key-feedback--success";
      feedback.innerHTML = `${ICON_CHECK}<span>Saved &amp; synced</span>`;
    } catch (err) {
      console.warn("[NeMoClaw] Provider key sync failed:", err);
      feedback.className = "nemoclaw-key-feedback nemoclaw-key-feedback--error";
      feedback.innerHTML = `${ICON_CLOSE}<span>Saved locally; sync failed</span>`;
    } finally {
      saveBtn.disabled = false;
      setTimeout(() => {
        feedback.className = "nemoclaw-key-feedback";
        feedback.textContent = "";
      }, 4000);
    }
  });

  return section;
}

// ---------------------------------------------------------------------------
// Key row and add-key form
// ---------------------------------------------------------------------------

function buildKeyRow(section: HTMLElement, keyName: string, label: string, _isBuiltIn: boolean): HTMLElement {
  const value = getSectionKeyValue(keyName);
  const wrapper = document.createElement("div");
  wrapper.className = "nemoclaw-key-field nemoclaw-inference-apikeys__key-row";
  wrapper.dataset.apiKeyName = keyName;

  const statusClass = isKeyConfigured(value) ? "nemoclaw-key-dot--ok" : "nemoclaw-key-dot--missing";
  const header = document.createElement("div");
  header.className = "nemoclaw-key-field__header nemoclaw-inference-apikeys__key-row-header";
  header.innerHTML = `
    <label class="nemoclaw-key-field__label">
      <span class="nemoclaw-key-field__label-text">${escapeHtml(label)}</span>
      <span class="nemoclaw-key-dot ${statusClass}"></span>
    </label>
    <button type="button" class="nemoclaw-inference-apikeys__key-row-delete" title="Remove key" aria-label="Remove">${ICON_TRASH}</button>`;

  const inputRow = document.createElement("div");
  inputRow.className = "nemoclaw-key-field__input-row";
  const input = document.createElement("input");
  input.type = "password";
  input.className = "nemoclaw-policy-input nemoclaw-key-field__input";
  input.placeholder = "Paste value";
  input.value = value;
  input.dataset.apiKeyName = keyName;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.addEventListener("input", () => {
    const dot = wrapper.querySelector(".nemoclaw-key-dot");
    if (dot) {
      dot.classList.toggle("nemoclaw-key-dot--ok", isKeyConfigured(input.value.trim()));
      dot.classList.toggle("nemoclaw-key-dot--missing", !isKeyConfigured(input.value.trim()));
    }
  });

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "nemoclaw-key-field__toggle";
  toggleBtn.innerHTML = ICON_EYE;
  toggleBtn.addEventListener("click", () => {
    const isHidden = input.type === "password";
    input.type = isHidden ? "text" : "password";
    toggleBtn.innerHTML = isHidden ? ICON_EYE_OFF : ICON_EYE;
  });
  inputRow.appendChild(input);
  inputRow.appendChild(toggleBtn);

  wrapper.appendChild(header);
  wrapper.appendChild(inputRow);

  const deleteBtn = wrapper.querySelector<HTMLButtonElement>(".nemoclaw-inference-apikeys__key-row-delete");
  deleteBtn?.addEventListener("click", () => {
    removeSectionKey(keyName);
    section.replaceWith(buildApiKeysSection());
  });

  return wrapper;
}

function buildAddKeyForm(_section: HTMLElement, form: HTMLElement, addKeyRow: HTMLElement): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "nemoclaw-inference-apikeys__add-form";

  const keyInput = document.createElement("input");
  keyInput.type = "text";
  keyInput.className = "nemoclaw-policy-input";
  keyInput.placeholder = "Name (e.g. OPENAI_API_KEY)";

  const valInput = document.createElement("input");
  valInput.type = "password";
  valInput.className = "nemoclaw-policy-input";
  valInput.placeholder = "Value";

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "nemoclaw-policy-confirm-btn nemoclaw-policy-confirm-btn--create";
  addBtn.textContent = "Add";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "nemoclaw-policy-confirm-btn nemoclaw-policy-confirm-btn--cancel";
  cancelBtn.textContent = "Cancel";

  addBtn.addEventListener("click", () => {
    const keyName = keyInput.value.trim();
    const value = valInput.value.trim();
    if (!keyName) return;
    const builtIn = KEY_FIELDS.find((f) => f.serverCredentialKey === keyName);
    const custom = getCustomKeys();
    if (builtIn || custom[keyName]) {
      setSectionKeyValue(keyName, value);
    } else {
      setCustomKey(keyName, value);
    }
    wrap.remove();
    const section = form.closest(".nemoclaw-inference-apikeys");
    if (section) section.replaceWith(buildApiKeysSection());
  });
  cancelBtn.addEventListener("click", () => wrap.remove());

  wrap.appendChild(keyInput);
  wrap.appendChild(valInput);
  wrap.appendChild(addBtn);
  wrap.appendChild(cancelBtn);
  return wrap;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function areAllKeysConfigured(): boolean {
  return KEY_FIELDS.every((f) => isKeyConfigured(f.get()));
}

/** Credential key names (e.g. NVIDIA_API_KEY) that the Environment variables section can provide. */
export function getSectionCredentialKeyNames(): string[] {
  const builtIn = KEY_FIELDS.map((f) => f.serverCredentialKey);
  const custom = Object.keys(getCustomKeys());
  return [...builtIn, ...custom];
}

/** Key names and display labels for the Environment variables section (for dropdowns). */
export function getSectionCredentialEntries(): { keyName: string; label: string }[] {
  const builtIn = KEY_FIELDS.map((f) => ({ keyName: f.serverCredentialKey, label: f.label }));
  const custom = Object.keys(getCustomKeys()).map((keyName) => ({ keyName, label: keyName }));
  return [...builtIn, ...custom];
}

/** Value for a credential key from the Environment variables section, or empty if not set. */
export function getSectionKeyValue(keyName: string): string {
  const field = KEY_FIELDS.find((f) => f.serverCredentialKey === keyName);
  if (field) return field.get();
  return getCustomKeys()[keyName] ?? "";
}

export function setSectionKeyValue(keyName: string, value: string): void {
  const field = KEY_FIELDS.find((f) => f.serverCredentialKey === keyName);
  if (field) field.set(value);
  else setCustomKey(keyName, value);
}

export function removeSectionKey(keyName: string): void {
  const field = KEY_FIELDS.find((f) => f.serverCredentialKey === keyName);
  if (field) field.set("");
  else removeCustomKey(keyName);
}
