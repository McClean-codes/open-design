import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const HEADERS_PATH = new URL('../public/_headers', import.meta.url);

/**
 * Parse Cloudflare Pages `_headers` into path → header-line map.
 * Comments and blank lines are dropped; continuation lines attach to the
 * nearest preceding path rule.
 */
function parseHeadersFile(source: string): Map<string, string[]> {
  const rules = new Map<string, string[]>();
  let current: string | null = null;

  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line || line.startsWith('#')) continue;

    if (/^\S/.test(line)) {
      current = line.trim();
      if (!rules.has(current)) rules.set(current, []);
      continue;
    }

    assert.ok(current, `header continuation without a path rule: ${line}`);
    rules.get(current)!.push(line.trim());
  }

  return rules;
}

function cacheControl(headers: string[]): string | undefined {
  const line = headers.find((h) => /^cache-control:\s*/i.test(h));
  return line?.replace(/^cache-control:\s*/i, '');
}

describe('landing-page Cloudflare Pages cache headers', () => {
  it('does not pin HTML behind custom edge TTLs that outlive a deploy', async () => {
    const source = await readFile(HEADERS_PATH, 'utf8');
    const rules = parseHeadersFile(source);

    // These path shapes matched every HTML document (/, /pricing/,
    // /blog/foo/index.html). Custom s-maxage / stale-while-revalidate on them
    // overrode Pages' deploy-scoped invalidation and left POPs serving the
    // previous deployment until the SWR window expired — hard-refresh only.
    for (const path of ['/', '/*/', '/*.html']) {
      assert.equal(
        rules.has(path),
        false,
        `${path} must not set custom Cache-Control; leave HTML on Pages defaults so deploys invalidate immediately`,
      );
    }

    // Belt-and-suspenders: no rule may reintroduce long edge freshness for
    // document-like responses. Hashed assets (/_astro, /enhancers) are the
    // only place long immutable TTLs belong.
    for (const [path, headers] of rules) {
      const cc = cacheControl(headers);
      if (!cc) continue;

      const isHashedAsset =
        path === '/_astro/*' ||
        path === '/enhancers/*' ||
        path.startsWith('/_astro/') ||
        path.startsWith('/enhancers/');

      if (isHashedAsset) {
        assert.match(
          cc,
          /max-age=31536000/i,
          `${path} should stay immutable forever`,
        );
        assert.match(cc, /immutable/i, `${path} should be marked immutable`);
        continue;
      }

      assert.doesNotMatch(
        cc,
        /\bs-maxage\b/i,
        `${path} must not set s-maxage; Pages deploy invalidation owns edge freshness for non-hashed responses`,
      );
      assert.doesNotMatch(
        cc,
        /\bstale-while-revalidate\b/i,
        `${path} must not set stale-while-revalidate; it can keep serving a previous deployment after publish`,
      );
    }
  });

  it('keeps hashed assets immutable and machine-readable static files short-TTL', async () => {
    const source = await readFile(HEADERS_PATH, 'utf8');
    const rules = parseHeadersFile(source);

    // This file only governs static Pages responses. Pages Functions generate
    // their own headers; do not assert Function paths here (CF does not apply
    // custom `_headers` rules to Function responses).
    assert.equal(
      cacheControl(rules.get('/_astro/*') ?? []),
      'public, max-age=31536000, immutable',
    );
    assert.equal(
      cacheControl(rules.get('/enhancers/*') ?? []),
      'public, max-age=31536000, immutable',
    );

    const plans = rules.get('/pricing/plans.json') ?? [];
    assert.ok(
      plans.some((h) => /^content-type:\s*application\/json; charset=utf-8$/i.test(h)),
    );
    assert.equal(cacheControl(plans), 'public, max-age=0, must-revalidate');
  });
});
