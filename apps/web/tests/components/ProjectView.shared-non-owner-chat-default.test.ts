import { describe, expect, it } from 'vitest';

import { shouldDefaultCollapseChatForSharedNonOwner } from '../../src/components/ProjectView';

describe('shouldDefaultCollapseChatForSharedNonOwner', () => {
  it('collapses chat for a confirmed shared team project the viewer does not own', () => {
    expect(
      shouldDefaultCollapseChatForSharedNonOwner({
        enabled: true,
        syncState: 'in_sync',
        isOwner: false,
      }),
    ).toBe(true);
  });

  it('keeps chat open for the project owner', () => {
    expect(
      shouldDefaultCollapseChatForSharedNonOwner({
        enabled: true,
        syncState: 'in_sync',
        isOwner: true,
      }),
    ).toBe(false);
  });

  it('keeps chat open for personal / unshared projects', () => {
    expect(
      shouldDefaultCollapseChatForSharedNonOwner({
        enabled: true,
        syncState: 'local_only',
        isOwner: false,
      }),
    ).toBe(false);
  });

  it('does not collapse while collab status is still unknown', () => {
    // Avoid a flash: owners briefly look non-owner until /collab/status lands.
    expect(
      shouldDefaultCollapseChatForSharedNonOwner({
        enabled: true,
        syncState: null,
        isOwner: false,
      }),
    ).toBe(false);
  });

  it('does not collapse when collab is dormant (personal workspace / signed out)', () => {
    expect(
      shouldDefaultCollapseChatForSharedNonOwner({
        enabled: false,
        syncState: 'in_sync',
        isOwner: false,
      }),
    ).toBe(false);
  });
});
