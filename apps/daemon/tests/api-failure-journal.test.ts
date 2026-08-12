import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearRecentApiFailures,
  readRecentApiFailures,
  recordApiFailure,
} from '../src/http/api-failure-journal.js';

describe('API failure diagnostics journal', () => {
  beforeEach(() => {
    clearRecentApiFailures();
  });

  it('retains bounded pre-run failure metadata without query strings or resource identifiers', () => {
    for (let index = 0; index < 105; index += 1) {
      recordApiFailure({
        at: `2026-08-12T03:57:${String(index % 60).padStart(2, '0')}Z`,
        method: 'POST',
        path: `/api/projects/550e8400-e29b-41d4-a716-446655440000/runs?prompt=secret-${index}`,
        status: 401,
        code: 'AMR_AUTH_REQUIRED',
        retryable: false,
        requestId: `request-${index}`,
      });
    }

    const failures = readRecentApiFailures();
    expect(failures).toHaveLength(100);
    expect(failures[0]?.requestId).toBe('request-5');
    expect(failures.at(-1)).toMatchObject({
      method: 'POST',
      path: '/api/projects/:id/runs',
      status: 401,
      code: 'AMR_AUTH_REQUIRED',
      retryable: false,
      requestId: 'request-104',
    });
    expect(JSON.stringify(failures)).not.toContain('prompt');
    expect(JSON.stringify(failures)).not.toContain('550e8400');
  });

  it('returns snapshots that callers cannot mutate', () => {
    recordApiFailure({
      at: '2026-08-12T03:57:36Z',
      method: 'GET',
      path: '/api/workspace/directory',
      status: 401,
      code: 'AMR_AUTH_REQUIRED',
      retryable: false,
    });

    const first = readRecentApiFailures();
    first.length = 0;
    expect(readRecentApiFailures()).toHaveLength(1);
  });
});
