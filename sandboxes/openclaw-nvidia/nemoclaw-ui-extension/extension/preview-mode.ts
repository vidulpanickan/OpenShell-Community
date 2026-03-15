/**
 * Preview mode: no backend. Used by dev-preview.sh so the UI renders with mock data.
 */

export function isPreviewMode(): boolean {
  try {
    return new URL(document.URL).searchParams.get("preview") === "1";
  } catch {
    return false;
  }
}

/** Minimal policy YAML so the policy page renders in preview. */
export const PREVIEW_POLICY_YAML = `version: 1

filesystem_policy:
  include_workdir: true
  read_only: []
  read_write: []

landlock:
  compatibility: best_effort

process:
  run_as_user: sandbox
  run_as_group: sandbox

network_policies: {}
`;
