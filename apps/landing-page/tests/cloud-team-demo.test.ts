import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(
  new URL('../app/pages/cloud-team-demo/index.astro', import.meta.url),
  'utf8',
);

test('cloud team upgrade demo leads the benefit list with the campaign entitlement', () => {
  assert.match(source, /DeepSeek V4 Flash 无限使用/);
  assert.match(source, /8 月 6 日—8 月 13 日 · 个人与团队付费用户同步生效/);
  assert.doesNotMatch(source, /权益生效后连续 7 天/);
  assert.doesNotMatch(source, /限时活动权益/);
  assert.match(source, /class="campaign-banner"/);
  assert.match(source, /background: radial-gradient/);
  assert.match(source, /data-campaign-countdown/);
  assert.match(source, /活动剩余 7天 00:00:00/);
  assert.match(source, /campaignCountdown\.textContent = `活动剩余 \$\{days\}天/);
  assert.match(source, /campaignCountdownEndsAt = Date\.now\(\) \+ 7 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(source, /\.campaign-banner \{[^}]*border:\s*0;/);
  assert.match(source, /套餐内的无限制模型额度与免费生成次数，仅可通过 Open Design使用；无法在 MCP \/ CLI\/ API及其他场景使用。解释权归官方所有。/);
  assert.doesNotMatch(source, /套餐内的<strong>无限制模型额度<\/strong>与<strong>免费生成次数<\/strong>/);
  assert.doesNotMatch(source, /\.campaign-disclaimer strong/);
  assert.ok(
    source.indexOf('DeepSeek V4 Flash 无限使用') < source.indexOf('{benefits.map'),
    'campaign entitlement should appear before the existing team benefit list',
  );
});

test('cloud team upgrade demo exposes personal and team pricing views', () => {
  assert.match(source, /data-audience-tab="personal"/);
  assert.match(source, /data-audience-tab="team"/);
  assert.match(source, /class="plan-grid personal-plan-grid"/);
  assert.match(source, /class="plan-grid team-plan-grid"/);
  assert.match(source, /升级 Pro/);
  assert.match(source, /升级 Team Pro/);
  assert.match(source, /个人版按月或按年订阅，模型额度按月发放/);
  assert.match(source, /new URLSearchParams\(window\.location\.search\)\.get\('planAudience'\)/);
  assert.match(source, /setAudience\(requestedAudience === 'personal' \? 'personal' : 'team'\)/);
});

test('cloud team upgrade demo links the campaign corner badge to pricing', () => {
  assert.match(source, /class="campaign-corner-badge" href="\/pricing\/"/);
  assert.match(source, /DeepSeek V4无限免费用/);
});

test('cloud team upgrade demo is review-only and cannot be indexed', () => {
  assert.match(source, /noindex, nofollow/);
});
