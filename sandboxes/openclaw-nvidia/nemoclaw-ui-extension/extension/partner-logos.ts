/**
 * Partner provider logos for Inference tab tiles.
 * Uses data URL for reliable rendering across contexts (no inline SVG parsing issues).
 */

/** Generic cloud icon as data URL so <img src> renders reliably. */
const GENERIC_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#71717a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>';
const GENERIC_ICON_DATA_URL = `data:image/svg+xml,${encodeURIComponent(GENERIC_ICON_SVG)}`;

/** logoId -> domain for Clearbit logo CDN (logo.clearbit.com). Falls back to generic if missing or load fails. */
const PARTNER_LOGO_DOMAINS: Record<string, string> = {
  Baseten: "baseten.co",
  DeepInfra: "deepinfra.com",
  Fireworks: "fireworks.ai",
  TogetherAI: "together.xyz",
  Anthropic: "anthropic.com",
  OpenAI: "openai.com",
  CoreWeave: "coreweave.com",
  Lightning: "lightning.ai",
  Vultr: "vultr.com",
  DigitalOcean: "digitalocean.com",
  Bitdeer: "bitdeer.com",
};

/**
 * Returns a URL suitable for <img src> so the logo renders on screen.
 * Uses Clearbit logo CDN for known partners; otherwise generic cloud icon.
 */
export function getPartnerLogoImgSrc(logoId: string): string {
  if (!logoId || logoId === "generic") return GENERIC_ICON_DATA_URL;
  const domain = PARTNER_LOGO_DOMAINS[logoId];
  if (domain) return `https://logo.clearbit.com/${domain}`;
  return GENERIC_ICON_DATA_URL;
}

/**
 * Returns inline SVG HTML for a partner logo (legacy).
 * Prefer getPartnerLogoImgSrc + <img> for reliable rendering.
 */
export function getPartnerLogoHtml(logoId: string): string {
  const src = getPartnerLogoImgSrc(logoId);
  return `<img src="${src.replace(/"/g, "&quot;")}" alt="" width="24" height="24" class="nc-partner-tile__logo-img">`;
}

/**
 * Returns a URL for a partner logo image (for <img src>).
 */
export function getPartnerLogoUrl(logoId: string): string | null {
  if (!logoId || logoId === "generic") return null;
  return null;
}
