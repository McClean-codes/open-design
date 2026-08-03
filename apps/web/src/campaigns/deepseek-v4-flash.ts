export const DEEPSEEK_V4_FLASH_CAMPAIGN = {
  id: 'deepseek-v4-flash-free-2026',
  modelId: 'deepseek-v4-flash',
  headline: '这次，别省着用。DeepSeek V4 Flash 放开跑。',
  description: '需求、文案、脚本、代码，想改就改，跑到满意为止。',
  badge: '不限次',
  cta: '现在就开跑',
  timing: '活动期间，产品内使用不计入小时及每日次数。',
  boundary: '适用于所有套餐；并发、排队及公平使用规则仍按当前套餐执行。API、MCP 与 CLI 调用不参与。',
} as const;

export const DEEPSEEK_V4_FLASH_CAMPAIGN_REVIEW_PARAM = 'deepseek-v4-flash';

export function isDeepSeekV4FlashCampaignModel(modelId: string | null | undefined): boolean {
  return modelId?.trim().toLowerCase() === DEEPSEEK_V4_FLASH_CAMPAIGN.modelId;
}
