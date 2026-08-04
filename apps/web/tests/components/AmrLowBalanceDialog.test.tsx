// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmrLowBalanceDialog } from '../../src/components/AmrLowBalanceDialog';

function renderDialog() {
  const onDecision = vi.fn();
  render(
    <AmrLowBalanceDialog
      balanceUsd="1.20"
      profile="prod"
      entrySource="chat_low_balance_warn_recharge"
      metricsConsent={false}
      installationId={null}
      onDecision={onDecision}
    />,
  );
  return { onDecision };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AmrLowBalanceDialog', () => {
  it('shows the wallet and deterministic media quote when the caller provides one', () => {
    render(
      <AmrLowBalanceDialog
        balanceUsd="0.80"
        profile={null}
        entrySource="home_low_balance_warn_recharge"
        metricsConsent={false}
        installationId={null}
        generationPriceUsd={1.08}
        onDecision={vi.fn()}
      />,
    );

    const summary = screen.getByTestId('amr-low-balance-dialog-generation-price');
    expect(summary).toHaveTextContent('Current allowance$0.80');
    expect(summary).toHaveTextContent('This generation$1.08');
    expect(screen.getByText(/automatic.*retried generations are not charged/i)).toBeTruthy();
  });

  it('opens the top-up flow for eligible paid accounts', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderDialog();

    const primary = screen.getByTestId('amr-low-balance-dialog-recharge');
    expect(primary.textContent).toBe('Top up');

    fireEvent.click(primary);

    const url = String(open.mock.calls[0]?.[0] ?? '');
    // The top-up entry must not carry B's upgrade intent — it opens the
    // console to add credit, not the plan catalog.
    expect(url).not.toContain('billing=plan');
  });

  it('dismisses from the corner close button', () => {
    const { onDecision } = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onDecision).toHaveBeenCalledWith('dismiss');
  });
});
