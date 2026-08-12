// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../src/i18n';
import { AmrAuthExpiredDialog } from '../../src/components/AmrAuthExpiredDialog';
import styles from '../../src/components/AmrAuthExpiredDialog.module.css';

describe('AmrAuthExpiredDialog', () => {
  it('uses the existing dialog/button language and offers later or sign in', () => {
    const onDismiss = vi.fn();
    render(
      <I18nProvider initial="zh-CN">
        <AmrAuthExpiredDialog onDismiss={onDismiss} onSignedIn={vi.fn()} />
      </I18nProvider>,
    );

    expect(screen.getByRole('alertdialog', { name: '登录已失效' })).toBeInTheDocument();
    expect(screen.getByRole('presentation')).toHaveClass(styles.backdrop!);
    expect(screen.getByText('登录状态已过期。登录后即可继续使用 Open Design Cloud。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '稍后' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
