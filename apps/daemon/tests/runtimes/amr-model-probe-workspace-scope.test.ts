import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { VelaCredentialRevision } from '../../src/integrations/vela.js';
import {
  buildAmrModelCacheKey,
  withVelaModelListWorkspaceScope,
} from '../../src/runtimes/amr-model-probe.js';

const CREDENTIAL_REVISION: VelaCredentialRevision = {
  authSource: 'file',
  profile: 'test',
  loggedIn: true,
  userId: 'user-1',
  userEmail: 'user@example.com',
  configMtimeMs: 1,
  credentialFingerprint: '',
};

test('withVelaModelListWorkspaceScope sets VELA_WORKSPACE_ID for Path A discovery', () => {
  const env = withVelaModelListWorkspaceScope(
    { HOME: '/tmp/home', VELA_PROFILE: 'test' },
    '  ws-team-pro  ',
  );
  assert.equal(env.VELA_WORKSPACE_ID, 'ws-team-pro');
  assert.equal(env.HOME, '/tmp/home');
});

test('withVelaModelListWorkspaceScope leaves env unscoped for blank workspace ids', () => {
  const env = withVelaModelListWorkspaceScope(
    { HOME: '/tmp/home' },
    '   ',
  );
  assert.equal('VELA_WORKSPACE_ID' in env, false);
});

test('buildAmrModelCacheKey partitions catalogs by workspace id', () => {
  const base = {
    launchPath: '/bin/vela',
    credentialRevision: CREDENTIAL_REVISION,
  };
  const personal = buildAmrModelCacheKey({
    ...base,
    env: { HOME: '/tmp/home', VELA_PROFILE: 'test' },
  });
  const team = buildAmrModelCacheKey({
    ...base,
    env: {
      HOME: '/tmp/home',
      VELA_PROFILE: 'test',
      VELA_WORKSPACE_ID: 'ws-team-pro',
    },
  });
  const teamAgain = buildAmrModelCacheKey({
    ...base,
    env: {
      HOME: '/tmp/home',
      VELA_PROFILE: 'test',
      VELA_WORKSPACE_ID: 'ws-team-pro',
    },
  });

  assert.notEqual(personal, team);
  assert.equal(team, teamAgain);
  assert.match(team, /ws-team-pro/);
});
