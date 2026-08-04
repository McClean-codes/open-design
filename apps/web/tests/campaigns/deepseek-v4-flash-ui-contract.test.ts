import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const entryShellSource = readFileSync(
  resolve(process.cwd(), 'src/components/EntryShell.tsx'),
  'utf8',
);

describe('DeepSeek V4 Flash workbench campaign entry', () => {
  it('shows a top-right pricing badge for explicit campaign audiences', () => {
    expect(entryShellSource).toContain('deepseek-campaign-pricing-badge');
    expect(entryShellSource).toContain('DeepSeek V4无限免费用');
    expect(entryShellSource).toContain('deepSeekV4FlashCampaignAudience !== \'unknown\'');
  });

  it('opens the official Pricing page in a separate browser context', () => {
    expect(entryShellSource).toContain('https://open-design.ai/zh/pricing/?source=desktop_campaign_badge');
    expect(entryShellSource).toContain('target="_blank"');
    expect(entryShellSource).toContain('rel="noopener noreferrer"');
  });
});
