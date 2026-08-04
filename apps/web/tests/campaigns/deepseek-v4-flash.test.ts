import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_V4_FLASH_CAMPAIGN,
  formatDeepSeekV4FlashCampaignCountdown,
  isDeepSeekV4FlashCampaignWindowOpen,
  resolveDeepSeekV4FlashCampaignAudience,
  isDeepSeekV4FlashCampaignModel,
} from '../../src/campaigns/deepseek-v4-flash';

const entryLayoutStyles = readFileSync(
  new URL('../../src/styles/home/entry-layout.css', import.meta.url),
  'utf8',
);
const campaignDialogSource = readFileSync(
  new URL('../../src/components/DeepSeekV4FlashCampaign.tsx', import.meta.url),
  'utf8',
);

describe('DeepSeek V4 Flash campaign', () => {
  it('keeps the promotion attached only to the Flash model', () => {
    expect(isDeepSeekV4FlashCampaignModel('deepseek-v4-flash')).toBe(true);
    expect(isDeepSeekV4FlashCampaignModel(' DeepSeek-V4-Flash ')).toBe(true);
    expect(isDeepSeekV4FlashCampaignModel('deepseek-v4-pro')).toBe(false);
    expect(isDeepSeekV4FlashCampaignModel('deepseek-v4')).toBe(false);
  });

  it('uses the approved cross-surface campaign explanation', () => {
    expect(DEEPSEEK_V4_FLASH_CAMPAIGN.description).toBe(
      '落地页、网站、幻灯片、图片，无限做，做到满意',
    );
  });

  it('keeps the fixed window out of the primary headline and badge', () => {
    expect(DEEPSEEK_V4_FLASH_CAMPAIGN.headline).not.toContain('限时');
    expect(DEEPSEEK_V4_FLASH_CAMPAIGN.badge).toBe('无限使用');
    expect(DEEPSEEK_V4_FLASH_CAMPAIGN.timing).toContain('8 月 8 日至 8 月 14 日');
    expect(DEEPSEEK_V4_FLASH_CAMPAIGN.timing).not.toContain('权益生效后');
  });

  it('uses a neutral gray restricted badge for anti-abuse fallback', () => {
    const restrictedBadgeRule = entryLayoutStyles.match(
      /\.inline-switcher__campaign-badge\.is-restricted\s*\{([^}]*)\}/,
    )?.[1];

    expect(restrictedBadgeRule).toContain('color: #5f645d');
    expect(restrictedBadgeRule).toContain('background: #e4e7e2');
    expect(restrictedBadgeRule).not.toMatch(/#ffd79a|#713a00/);
  });

  it('keeps the campaign promise stable while routing actions by entitlement', () => {
    expect(DEEPSEEK_V4_FLASH_CAMPAIGN.paid.cta).toBe('立即使用');
    expect(DEEPSEEK_V4_FLASH_CAMPAIGN.unpaid.cta).toContain('升级套餐');
    expect(DEEPSEEK_V4_FLASH_CAMPAIGN.paid.modelBadge).toBe('无限使用');
    expect(DEEPSEEK_V4_FLASH_CAMPAIGN.unpaid.modelBadge).toBe('升级可用');
    expect(DEEPSEEK_V4_FLASH_CAMPAIGN.unpaid.tooltip).toContain('8 月 15 日 00:00');
    expect(DEEPSEEK_V4_FLASH_CAMPAIGN.restricted.modelBadge).toBe('已暂停');
    expect(DEEPSEEK_V4_FLASH_CAMPAIGN.restricted.tooltip).toContain('异常的大规模使用');
    expect(DEEPSEEK_V4_FLASH_CAMPAIGN.boundary).toContain('不设个人免费额度');

    expect(resolveDeepSeekV4FlashCampaignAudience({
      plan: 'plus',
      loggedIn: true,
    })).toBe('paid');
    expect(resolveDeepSeekV4FlashCampaignAudience({
      plan: 'team_pro',
      loggedIn: true,
    })).toBe('paid');
    expect(resolveDeepSeekV4FlashCampaignAudience({
      plan: 'free',
      loggedIn: true,
    })).toBe('unpaid');
    expect(resolveDeepSeekV4FlashCampaignAudience({
      plan: null,
      loggedIn: null,
    })).toBe('unknown');
    expect(resolveDeepSeekV4FlashCampaignAudience({
      plan: 'plus',
      loggedIn: true,
      search: '?campaignAudience=unpaid',
    })).toBe('unpaid');
  });

  it('keeps the paid modal actions on the final approved interaction', () => {
    expect(campaignDialogSource).toContain('{presentation.cta}');
    expect(campaignDialogSource).toContain('稍后再说');
    expect(campaignDialogSource).toContain('/campaigns/deepseek-v4-flash-free-week-poster-v5.png');
    expect(campaignDialogSource).toContain('deepseek-v4-flash-campaign-cover');
    expect(campaignDialogSource).toMatch(/className=\{styles\.dismissAction\}/);
    expect(campaignDialogSource).toMatch(/onClick=\{closeModal\}/);
  });

  it('shows a shared live countdown in both paid and unpaid campaign modals', () => {
    const start = Date.parse(DEEPSEEK_V4_FLASH_CAMPAIGN.window.startAt);
    const end = Date.parse(DEEPSEEK_V4_FLASH_CAMPAIGN.window.endAtExclusive);

    expect(formatDeepSeekV4FlashCampaignCountdown(start - 1_000)).toContain('距开始');
    expect(formatDeepSeekV4FlashCampaignCountdown(start)).toContain('活动剩余');
    expect(formatDeepSeekV4FlashCampaignCountdown(end)).toBe('活动已结束');
    expect(campaignDialogSource).toContain('deepseek-v4-flash-campaign-countdown');
    expect(campaignDialogSource).toContain('一周免费用');
    expect(campaignDialogSource.indexOf('styles.countdown')).toBeLessThan(
      campaignDialogSource.indexOf('styles.modelCard'),
    );
  });

  it('keeps the unpaid action on the upgrade flow without showing the paid secondary action', () => {
    expect(DEEPSEEK_V4_FLASH_CAMPAIGN.unpaid.cta).toBe('升级套餐，立即使用');
    expect(campaignDialogSource).toContain("window.open(plansUrl, '_blank', 'noopener,noreferrer')");
    expect(campaignDialogSource).toContain("{paid ? '稍后再说' : '关闭'}");
  });

  it('opens for every paid user only inside the shared half-open window', () => {
    const start = Date.parse(DEEPSEEK_V4_FLASH_CAMPAIGN.window.startAt);
    const end = Date.parse(DEEPSEEK_V4_FLASH_CAMPAIGN.window.endAtExclusive);

    expect(isDeepSeekV4FlashCampaignWindowOpen(start - 1)).toBe(false);
    expect(isDeepSeekV4FlashCampaignWindowOpen(start)).toBe(true);
    expect(isDeepSeekV4FlashCampaignWindowOpen(end - 1)).toBe(true);
    expect(isDeepSeekV4FlashCampaignWindowOpen(end)).toBe(false);
  });
});
