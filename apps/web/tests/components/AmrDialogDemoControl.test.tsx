// @vitest-environment jsdom

import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmrDialogDemoControl } from '../../src/components/AmrDialogDemoControl';

afterEach(cleanup);

describe('AmrDialogDemoControl', () => {
  it.each([
    ['Insufficient balance', 'balance'],
    ['Low balance', 'low-balance'],
    ['Artifact upgrade', 'artifact-upgrade'],
  ] as const)('opens the %s dialog state', (label, kind) => {
    const onOpen = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <AmrDialogDemoControl
          open={open}
          onOpenChange={setOpen}
          onOpen={onOpen}
        />
      );
    }
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Demo' }));
    fireEvent.click(screen.getByRole('menuitem', { name: label }));

    expect(onOpen).toHaveBeenCalledWith(kind);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
