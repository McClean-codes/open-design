import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(
  new URL('../app/pages/cloud-team-demo/index.astro', import.meta.url),
  'utf8',
);

test('cloud team upgrade demo leads the benefit list with the campaign entitlement', () => {
  assert.match(source, /DeepSeek V4 Flash 无限使用/);
  assert.match(source, /8 月 6 日—8 月 13 日 · 团队付费用户生效/);
  assert.doesNotMatch(source, /权益生效后连续 7 天/);
  assert.doesNotMatch(source, /限时活动权益/);
  assert.match(source, /class="campaign-banner"/);
  assert.match(source, /background: radial-gradient/);
  assert.match(source, /data-campaign-countdown/);
  assert.match(source, /活动剩余 7天 00:00:00/);
  assert.match(source, /campaignCountdown\.textContent = `活动剩余 \$\{days\}天/);
  assert.match(source, /campaignPreviewEndAt = Date\.now\(\) \+ 7 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(source, /now >= campaignStartAt && now < campaignEndAt/);
  assert.match(source, /data-campaign-surface/);
  assert.match(source, /\.campaign-banner \{[^}]*border:\s*0;/);
  assert.match(source, /套餐内的无限制模型额度与免费生成次数，仅可通过Open Design使用；无法在MCP\/CLI\/API及其他场景使用。解释权归官方所有。/);
  assert.doesNotMatch(source, /套餐内的<strong>无限制模型额度<\/strong>与<strong>免费生成次数<\/strong>/);
  assert.doesNotMatch(source, /\.campaign-disclaimer strong/);
  assert.ok(
    source.indexOf('DeepSeek V4 Flash 无限使用') < source.indexOf('{benefits.map'),
    'campaign entitlement should appear before the existing team benefit list',
  );
});

test('cloud team upgrade demo preserves the production team-only structure', () => {
  assert.match(source, /class="plan-grid team-plan-grid"/);
  assert.match(source, /升级 Team Pro/);
  assert.match(source, /团队版按席位按月计费，最少 3 席/);
  assert.doesNotMatch(source, /data-audience-tab/);
  assert.doesNotMatch(source, /personalPlans/);
  assert.doesNotMatch(source, /personal-plan-grid/);
  assert.doesNotMatch(source, /planAudience/);
});

test('cloud team upgrade demo links the campaign corner badge to pricing', () => {
  assert.match(source, /data-campaign-pricing-link/);
  assert.match(source, /href="\/zh\/pricing\/\?campaign=deepseek-v4-flash"/);
  assert.match(source, /DeepSeek V4无限免费用/);
});

test('cloud plan demo tracks the team campaign conversion path', () => {
  assert.match(source, /<SiteAnalytics \/>/);
  assert.match(source, /page_name: 'cloud_team_demo'/);
  assert.match(source, /element: 'plan_options'/);
  assert.match(source, /element: 'deepseek_v4_flash_benefit'/);
  assert.match(source, /element: 'upgrade'/);
  assert.match(source, /element: 'open_pricing'/);
  assert.match(source, /landing_pricing_team_plan/);
  assert.match(source, /plan_audience: 'team'/);
  assert.doesNotMatch(source, /landing_pricing_personal_plan/);
  assert.doesNotMatch(source, /element: 'audience_tab'/);
  assert.match(source, /window\.__odRecordCampaignEntry\?\./);
  assert.match(source, /window\.__odAttributedUrl\?\./);
  assert.match(source, /data-modal-action="later"/);
  assert.match(source, /data-modal-action="upgrade"/);
});

test('cloud team upgrade demo is review-only and cannot be indexed', () => {
  assert.match(source, /noindex, nofollow/);
});
