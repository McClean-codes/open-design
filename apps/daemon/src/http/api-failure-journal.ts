const MAX_RECENT_API_FAILURES = 100;

export interface RecentApiFailure {
  at: string;
  method: string;
  path: string;
  status: number;
  code: string;
  retryable: boolean;
  requestId?: string;
}

const failures: RecentApiFailure[] = [];

function sanitizePath(path: string): string {
  const pathname = path.split(/[?#]/u, 1)[0] || '/';
  return pathname
    .split('/')
    .map((segment) => {
      if (!segment) return segment;
      if (/^\d+$/u.test(segment)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(segment)) return ':id';
      if (/^[A-Za-z0-9_-]{24,}$/u.test(segment)) return ':id';
      return segment;
    })
    .join('/');
}

export function recordApiFailure(failure: RecentApiFailure): void {
  failures.push({
    ...failure,
    method: failure.method.toUpperCase(),
    path: sanitizePath(failure.path),
  });
  if (failures.length > MAX_RECENT_API_FAILURES) {
    failures.splice(0, failures.length - MAX_RECENT_API_FAILURES);
  }
}

export function readRecentApiFailures(): RecentApiFailure[] {
  return failures.map((failure) => ({ ...failure }));
}

/** Test-only reset for this process-local diagnostic journal. */
export function clearRecentApiFailures(): void {
  failures.length = 0;
}
