// @vitest-environment jsdom
//
// Behavioral contract for the DeepSeek V4 Flash campaign modal
// (`DeepSeekV4FlashCampaign`). The dialog portals to `document.body` while
// EntryShell keeps every entry view mounted behind `display:none`, so these
// specs pin the behaviors the source-contract tests cannot see:
//
// 1. the modal only interrupts the ACTIVE home view (要求文档:弹窗只在
//    #/home 展示,不在编辑器或其他工作流中打断用户), and re-arms when the
//    user returns to home without having dismissed it;
// 2. frequency control fails closed — an unreadable localStorage must not
//    turn "活动期内出现一次" into "every mount";
// 3. the paid 立即使用 CTA actually moves the workbench onto the campaign
//    model (agent `amr`, model `deepseek-v4-flash`) instead of only opening
//    the model picker (产品拍板 D5);
// 4. the `?campaign=` review fixture is inert in production builds (D7);
// 5. the unpaid upgrade path carries the telemetry consent + device id the
//    other two campaign touchpoints already forward.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekV4FlashCampaign } from '../../src/components/DeepSeekV4FlashCampaign';

const trackSpy = vi.fn();

vi.mock('../../src/analytics/provider', () => ({
  useAnalytics: () => ({ track: trackSpy }),
}));

vi.mock('../../src/collab/useWorkspaceContext', () => ({
  useWorkspaceContext: () => ({
    context: null,
    resourceReadIdentity: null,
    loading: false,
    identityChangePending: false,
  }),
}));

vi.mock('../../src/analytics/client', () => ({
  getResolvedDeviceId: () => null,
}));

const DIALOG = 'deepseek-v4-flash-campaign-dialog';

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  trackSpy.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState({}, '', '/');
});

describe('campaign modal only interrupts the active home view', () => {
  it('stays silent on non-home views even when the campaign is unseen', () => {
    render(<DeepSeekV4FlashCampaign audience="paid" active={false} />);

    expect(screen.queryByTestId(DIALOG)).toBeNull();
  });

  it('opens once home becomes active while the campaign is still unseen', () => {
    const { rerender } = render(
      <DeepSeekV4FlashCampaign audience="paid" active={false} />,
    );
    expect(screen.queryByTestId(DIALOG)).toBeNull();

    rerender(<DeepSeekV4FlashCampaign audience="paid" active />);

    expect(screen.getByTestId(DIALOG)).toBeInTheDocument();
  });

  it('re-arms when the user leaves home without dismissing and comes back', () => {
    const { rerender } = render(
      <DeepSeekV4FlashCampaign audience="paid" active />,
    );
    expect(screen.getByTestId(DIALOG)).toBeInTheDocument();

    // Navigating away is not a dismissal: the dialog disappears with the
    // view but must NOT be marked seen…
    rerender(<DeepSeekV4FlashCampaign audience="paid" active={false} />);
    expect(screen.queryByTestId(DIALOG)).toBeNull();

    // …so returning to home within the window shows it again.
    rerender(<DeepSeekV4FlashCampaign audience="paid" active />);
    expect(screen.getByTestId(DIALOG)).toBeInTheDocument();
  });
});
