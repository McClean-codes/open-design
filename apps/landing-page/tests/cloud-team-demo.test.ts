import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(
  new URL('../app/pages/cloud-team-demo/index.astro', import.meta.url),
  'utf8',
);

test('cloud team upgrade demo leads the benefit list with the campaign entitlement', () => {
  assert.match(source, /DeepSeek V4 Flash 无限使用/);
  assert.match(source, /8 月 8 日—8 月 14 日 · 付费团队成员免费使用/);
  assert.doesNotMatch(source, /权益生效后连续 7 天/);
  assert.match(source, /<p class="campaign-benefit">\s*<span>✓<\/span>/);
  assert.match(source, /\.benefits > p\.campaign-benefit \{ font-size: 13px;/);
  assert.doesNotMatch(source, /\.campaign-benefit[^\n]*border-bottom/);
  assert.ok(
    source.indexOf('DeepSeek V4 Flash 无限使用') < source.indexOf("{benefits.map"),
    'campaign entitlement should appear before the existing team benefit list',
  );
});

test('cloud team upgrade demo is review-only and cannot be indexed', () => {
  assert.match(source, /noindex, nofollow/);
});
