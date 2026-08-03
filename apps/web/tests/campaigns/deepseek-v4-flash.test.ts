import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_V4_FLASH_CAMPAIGN,
  resolveDeepSeekV4FlashCampaignAudience,
  isDeepSeekV4FlashCampaignModel,
} from '../../src/campaigns/deepseek-v4-flash';

describe('DeepSeek V4 Flash campaign', () => {
  it('keeps the promotion attached only to the Flash model', () => {
    expect(isDeepSeekV4FlashCampaignModel('deepseek-v4-flash')).toBe(true);
    expect(isDeepSeekV4FlashCampaignModel(' DeepSeek-V4-Flash ')).toBe(true);
    expect(isDeepSeekV4FlashCampaignModel('deepseek-v4-pro')).toBe(false);
    expect(isDeepSeekV4FlashCampaignModel('deepseek-v4')).toBe(false);
  });

  it('keeps timing out of the primary headline and badge', () => {
    expect(DEEPSEEK_V4_FLASH_CAMPAIGN.headline).not.toContain('限时');
    expect(DEEPSEEK_V4_FLASH_CAMPAIGN.badge).toBe('无限使用');
    expect(DEEPSEEK_V4_FLASH_CAMPAIGN.timing).toContain('连续 7 天');
  });

  it('keeps the campaign promise stable while routing actions by entitlement', () => {
    expect(DEEPSEEK_V4_FLASH_CAMPAIGN.paid.cta).toBe('现在就开跑');
    expect(DEEPSEEK_V4_FLASH_CAMPAIGN.unpaid.cta).toContain('升级套餐');
    expect(DEEPSEEK_V4_FLASH_CAMPAIGN.paid.modelBadge).toBe('无限使用');
    expect(DEEPSEEK_V4_FLASH_CAMPAIGN.unpaid.modelBadge).toBe('升级解锁');

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
});
