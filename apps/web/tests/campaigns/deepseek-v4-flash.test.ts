import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_V4_FLASH_CAMPAIGN,
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
    expect(DEEPSEEK_V4_FLASH_CAMPAIGN.badge).toBe('不限次');
    expect(DEEPSEEK_V4_FLASH_CAMPAIGN.timing).toContain('活动期间');
  });
});
