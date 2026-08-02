// @vitest-environment jsdom
//
// Product intentionally does not expose the message center in the web shell.
// Keep this at the rail boundary so both identity branches stay protected:
// signed-in users must not get an account-menu entry, and signed-out users
// must not get a standalone rail entry. The underlying notification settings
// and message-center client remain available for future product work.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntryNavRail, resetWorkspaceDirectoryCache } from '../../src/components/EntryNavRail';
import { I18nProvider } from '../../src/i18n';

function teamContext(): WorkspaceCollabContext {
  return {
    workspaceId: 'ws-team',
    workspaceType: 'team',
    workspaceMemberId: 'wm-1',
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: 'team_plus',
    displayName: 'Leaf',
    seatSummary: { seatLimit: 5, usedSeats: 1, availableSeats: 4, isSeatFull: false },
    permissions: { canInviteMembers: true, canViewWorkspaceSettings: true },
    workspaceSettingsUrl: 'https://web.example.com/console/settings?workspaceId=ws-team',
  } as unknown as WorkspaceCollabContext;
}

function renderRail(context: WorkspaceCollabContext | null) {
  return render(
    <I18nProvider initial="zh-CN">
      <EntryNavRail
        view="home"
        onViewChange={() => {}}
        onNewProject={() => {}}
        open
        context={context}
        billing={null}
      />
    </I18nProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  resetWorkspaceDirectoryCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/status')) return Response.json({ loggedIn: false });
      return Response.json({ items: [] });
    }),
  );
});

afterEach(() => {
  cleanup();
  resetWorkspaceDirectoryCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('EntryNavRail message-center visibility', () => {
  it('does not expose a message-center entry for signed-in users', () => {
    renderRail(teamContext());
    fireEvent.click(screen.getByTestId('entry-nav-account'));

    expect(screen.queryByTestId('account-menu-message-center')).toBeNull();
    expect(screen.queryByTestId('message-center-trigger')).toBeNull();
    expect(screen.queryByTestId('message-center-dialog')).toBeNull();
  });

  it('does not expose a message-center entry for signed-out users', () => {
    renderRail(null);

    expect(screen.queryByTestId('entry-nav-message-center')).toBeNull();
    expect(screen.queryByTestId('message-center-trigger')).toBeNull();
    expect(screen.queryByTestId('message-center-dialog')).toBeNull();
  });
});
