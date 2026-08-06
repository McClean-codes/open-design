import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const entryShellSource = readFileSync(
  resolve(process.cwd(), 'src/components/EntryShell.tsx'),
  'utf8',
);
const entryLayoutStyles = readFileSync(
  resolve(process.cwd(), 'src/styles/home/entry-layout.css'),
  'utf8',
);
const homeHeroStyles = readFileSync(
  resolve(process.cwd(), 'src/styles/home/home-hero.css'),
  'utf8',
);
const modelSwitcherSource = readFileSync(
  resolve(process.cwd(), 'src/components/InlineModelSwitcher.tsx'),
  'utf8',
);
const homeViewSource = readFileSync(
  resolve(process.cwd(), 'src/components/HomeView.tsx'),
  'utf8',
);
const campaignModalSource = readFileSync(
  resolve(process.cwd(), 'src/components/DeepSeekV4FlashCampaign.tsx'),
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
    expect(entryShellSource).toContain("'deepseek_workbench_badge'");
    expect(entryShellSource).toContain('attributedAmrUrl(DEEPSEEK_CAMPAIGN_PRICING_URL, attribution)');
    expect(entryShellSource).toContain("'noopener,noreferrer'");
  });

  it('uses a restrained green campaign treatment from shared brand tokens', () => {
    const badgeRule = entryLayoutStyles.match(
      /\.entry-deepseek-campaign-badge\s*\{([^}]*)\}/,
    )?.[1];

    expect(badgeRule).toContain('color: var(--brand-text)');
    expect(badgeRule).toContain('border: 1px solid color-mix(in srgb, var(--brand) 42%, var(--border))');
    expect(badgeRule).toContain('background: color-mix(in srgb, var(--brand-soft) 82%, var(--bg-panel))');
    expect(badgeRule).toContain('border-radius: var(--radius-pill)');
    expect(entryLayoutStyles).toContain('.entry-deepseek-campaign-badge::before');
    expect(entryLayoutStyles).toContain('background: var(--brand-text)');
    expect(entryLayoutStyles).toContain('.entry-deepseek-campaign-badge svg');
    expect(badgeRule).not.toContain('color: var(--green)');
    expect(badgeRule).not.toContain('background: transparent');
  });

  it('models the unpaid review URL as a signed-in user with existing models', () => {
    expect(modelSwitcherSource).toContain('DEEPSEEK_CAMPAIGN_REVIEW_MODELS');
    expect(modelSwitcherSource).toContain('DEEPSEEK_UNPAID_REVIEW_DEFAULT_MODEL_ID');
    expect(modelSwitcherSource).toContain("campaignAudienceOverride === 'unpaid'");
    expect(modelSwitcherSource).toContain('!isDeepSeekV4FlashCampaignModel(model.id)');
    expect(modelSwitcherSource).toContain('data-campaign-review');
    expect(homeHeroStyles).toContain('.inline-switcher[data-campaign-review]');
    expect(homeHeroStyles).toContain('max-width: 220px');
  });

  it('carries a campaign-specific attribution id into the model upgrade flow', () => {
    expect(modelSwitcherSource).toContain("'deepseek_model_switcher_upgrade'");
    expect(modelSwitcherSource).toContain('attributedAmrUrl(');
    expect(modelSwitcherSource).toContain('campaignNeedsUpgrade');
  });

  it('mounts the campaign modal gated on the active home view only', () => {
    // EntryShell hides inactive entry views with display:none while the
    // Dialog portals to document.body, so visibility CSS alone cannot stop
    // the modal from interrupting projects/tasks/... routes. The home-view
    // activity signal must reach the modal as a prop.
    expect(entryShellSource).toContain("isActive={view === 'home'}");
    expect(homeViewSource).toMatch(
      /<DeepSeekV4FlashCampaign[\s\S]*?active=\{isActive\}/,
    );
    expect(campaignModalSource).toMatch(/if \(!active\)/);
  });

  it('re-arms the unseen modal when the user returns to the home view', () => {
    // Leaving home closes the dialog WITHOUT marking it seen; the open
    // effect must therefore re-run on the activity flip, not only on the
    // audience settling.
    expect(campaignModalSource).toMatch(/\}, \[active, audience\]\);/);
    expect(campaignModalSource).toMatch(
      /if \(!active \|\| !modalOpen \|\| audience === 'unknown'/,
    );
  });

  it('tracks campaign discovery surfaces without replacing model-selection events', () => {
    expect(entryShellSource).toContain('trackDeepSeekCampaignBadgeSurfaceView');
    expect(entryShellSource).toContain('trackDeepSeekCampaignBadgeClick');
    expect(modelSwitcherSource).toContain('trackDeepSeekCampaignModelBenefitSurfaceView');
    expect(modelSwitcherSource).toContain('trackExecutionSettingsPopoverClick');
  });
});
