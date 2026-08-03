export const DEEPSEEK_V4_FLASH_CAMPAIGN = {
  id: 'deepseek-v4-flash-unlimited-2026',
  modelId: 'deepseek-v4-flash',
  headline: '这次，别省着用。DeepSeek V4 Flash 放开跑。',
  description: '需求、文案、脚本、代码，想改就改，跑到满意为止。',
  badge: '无限使用',
  benefit: 'DeepSeek V4 Flash 无限使用',
  timing: '权益生效后连续 7 天',
  paid: {
    eyebrow: '你的套餐已包含',
    status: '已解锁 · 连续 7 天无限使用',
    cta: '现在就开跑',
    secondaryCta: '稍后再说',
    modelBadge: '无限使用',
  },
  unpaid: {
    eyebrow: '订阅专享权益',
    status: '订阅后解锁 · 连续 7 天无限使用',
    cta: '升级套餐，立即开跑',
    secondaryCta: '先看看',
    modelBadge: '升级解锁',
  },
  boundary: '仅限产品内使用；并发、排队及合理使用规则仍然适用，不包含 API、MCP 和 CLI 调用。',
} as const;

export const DEEPSEEK_V4_FLASH_CAMPAIGN_REVIEW_PARAM = 'deepseek-v4-flash';
export const DEEPSEEK_V4_FLASH_CAMPAIGN_AUDIENCE_PARAM = 'campaignAudience';

export type DeepSeekV4FlashCampaignAudience = 'paid' | 'unpaid' | 'unknown';

export function deepSeekV4FlashCampaignAudienceOverride(
  search: string | null | undefined,
): Exclude<DeepSeekV4FlashCampaignAudience, 'unknown'> | null {
  if (!search) return null;
  const value = new URLSearchParams(search).get(
    DEEPSEEK_V4_FLASH_CAMPAIGN_AUDIENCE_PARAM,
  );
  return value === 'paid' || value === 'unpaid' ? value : null;
}

export function resolveDeepSeekV4FlashCampaignAudience(input: {
  plan: string | null | undefined;
  loggedIn: boolean | null | undefined;
  search?: string | null;
}): DeepSeekV4FlashCampaignAudience {
  const override = deepSeekV4FlashCampaignAudienceOverride(input.search);
  if (override) return override;

  const plan = input.plan?.trim().toLowerCase() ?? '';
  if (plan === 'free' || input.loggedIn === false) return 'unpaid';
  if (plan) return 'paid';
  return 'unknown';
}

export function isDeepSeekV4FlashCampaignModel(modelId: string | null | undefined): boolean {
  return modelId?.trim().toLowerCase() === DEEPSEEK_V4_FLASH_CAMPAIGN.modelId;
}
