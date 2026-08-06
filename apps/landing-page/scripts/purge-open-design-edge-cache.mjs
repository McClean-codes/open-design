#!/usr/bin/env node
/**
 * Purge Cloudflare edge cache for the production marketing host.
 *
 * Used by `landing-page-production` after `pages deploy` so locale HTML
 * (`/`, `/zh/pricing/`, …) does not keep serving pre-deploy objects when
 * CF Pages' deploy invalidation is incomplete for the custom domain.
 *
 * Auth: CLOUDFLARE_API_TOKEN with Zone → Cache Purge on the open-design.ai zone.
 * Zone: CLOUDFLARE_ZONE_ID (optional; defaults to the open-design.ai zone id).
 *
 * Scope: hosts purge is intentional — one host, all paths/locales, without
 * touching other hostnames on the same zone (e.g. download.open-design.ai).
 *
 * @see https://developers.cloudflare.com/api/resources/cache/methods/purge/
 * @see https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-hostname/
 */
const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
const zoneId =
  process.env.CLOUDFLARE_ZONE_ID?.trim() || "84ed4658186179c7eba52659b6ef48ad";
const hosts = (process.env.CLOUDFLARE_PURGE_HOSTS || "open-design.ai")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

if (!token) {
  console.error("CLOUDFLARE_API_TOKEN is required");
  process.exit(1);
}
if (hosts.length === 0) {
  console.error("CLOUDFLARE_PURGE_HOSTS resolved to an empty host list");
  process.exit(1);
}

const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`;
const body = { hosts };

const response = await fetch(url, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});

const payload = await response.json().catch(() => null);
const ok = response.ok && payload && payload.success === true;

console.log(
  JSON.stringify(
    {
      httpStatus: response.status,
      zoneId,
      hosts,
      success: Boolean(ok),
      errors: payload?.errors ?? null,
      result: payload?.result ?? null,
    },
    null,
    2,
  ),
);

if (!ok) {
  console.error(
    "Cloudflare host purge failed. Ensure CLOUDFLARE_API_TOKEN has Zone.Cache Purge on open-design.ai.",
  );
  process.exit(1);
}
