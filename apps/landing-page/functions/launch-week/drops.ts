/**
 * Serves the revealed Launch Week drops, and only the ones whose day has
 * arrived.
 *
 * The page itself is static, so anything baked into its HTML is readable by
 * anyone from the moment it deploys — which would hand out the running order
 * days before each reveal. The sealed cards ship in the page; the revealed
 * markup lives here and is released on the hour, without needing a deploy.
 *
 * A day opens at 08:00 UTC+8, which is exactly 00:00 UTC. UTC+8 observes no
 * daylight saving, so a plain UTC timestamp is the whole calculation.
 */
import { LW_DROP_MARKUP } from '../../app/_partials/launch-week-drops';

type PagesFunctionContext<Env> = {
  request: Request;
  env: Env;
};

type PagesFunction<Env> = (context: PagesFunctionContext<Env>) => Response | Promise<Response>;

/** Day N opens at 2026-08-{09+N} 00:00 UTC. */
const OPENS_AT = [
  '2026-08-10T00:00:00Z',
  '2026-08-11T00:00:00Z',
  '2026-08-12T00:00:00Z',
  '2026-08-13T00:00:00Z',
  '2026-08-14T00:00:00Z',
].map((iso) => Date.parse(iso));

/**
 * Shared with the page so the team can rehearse a day before it opens. It is a
 * gate against a casual URL guess, not a secret: anyone holding it can read the
 * running order early, so it stays inside the team.
 */
const PREVIEW_KEY = 'lw01-dry-run';

/**
 * Cache until the next boundary rather than for a fixed window, so the edge
 * cannot keep serving yesterday's set into the new day. Clamped to a minute so
 * a clock skew near the boundary self-corrects quickly.
 */
function secondsUntilNextOpen(now: number): number {
  const next = OPENS_AT.find((t) => t > now);
  if (next === undefined) return 3600;
  return Math.max(60, Math.min(3600, Math.floor((next - now) / 1000)));
}

export const onRequest: PagesFunction<Record<string, never>> = ({ request }) => {
  const url = new URL(request.url);
  const locale = url.searchParams.get('locale') ?? 'en';
  const preview = url.searchParams.get('key') === PREVIEW_KEY ? url.searchParams.get('preview') : null;

  const now = Date.now();
  const openThrough = preview === 'all' ? 5 : Number(preview) >= 1 && Number(preview) <= 5
    ? Number(preview)
    : OPENS_AT.filter((t) => now >= t).length;

  const byLocale = LW_DROP_MARKUP[locale] ?? LW_DROP_MARKUP.en;
  const drops = byLocale.slice(0, openThrough).map((html, i) => ({ day: i + 1, html }));

  return new Response(JSON.stringify({ drops }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // A preview response is per-request and must never be cached publicly.
      'Cache-Control': preview
        ? 'no-store'
        : `public, max-age=60, s-maxage=${secondsUntilNextOpen(now)}`,
    },
  });
};
