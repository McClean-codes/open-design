/**
 * The packaged Windows smoke's app-shell probe and the rule that reads it.
 *
 * `specs/win.spec.ts` only executes on a Windows runner that has a packaged
 * build installed, and the probe below reaches the packaged renderer as a
 * plain string through `tools-pack inspect --expr` — so neither the compiler
 * nor any cross-platform suite ever sees it. Keeping the probe text and the
 * terminal-state rule that consumes its result in one pure module lets
 * `tests/packaged/app-shell.test.ts` hold both to a contract from any platform.
 */

/**
 * Runs inside the packaged renderer. Written as a two-argument arrow function
 * rather than an IIFE so the exact same text can be evaluated in Node against a
 * fixture document (see `evaluatePackagedAppShellProbe`); in the renderer both
 * arguments are the ordinary globals.
 */
const PACKAGED_APP_SHELL_PROBE = `
  (doc, ElementCtor) => {
    const home = doc.querySelector('[data-testid="entry-nav-home"]');
    const onboardingShell = doc.querySelector('.entry-shell--onboarding, .entry-onboarding-modal');
    const cloudSignIn = doc.querySelector('.onboarding-cloud__primary');
    const secondaryLinks = Array.from(doc.querySelectorAll('.onboarding-cloud__secondary'));
    return {
      byokLinkVisible: secondaryLinks[1] instanceof ElementCtor,
      cloudSignInVisible: cloudSignIn instanceof ElementCtor,
      homeVisible: home instanceof ElementCtor && home.getClientRects().length > 0,
      localLinkVisible: secondaryLinks[0] instanceof ElementCtor,
      onboardingVisible: onboardingShell instanceof ElementCtor,
      text: doc.body?.textContent?.trim().slice(0, 300) ?? '',
      title: doc.title,
    };
  }
`;

export const packagedAppShellExpression = `(${PACKAGED_APP_SHELL_PROBE})(document, HTMLElement)`;

export type PackagedAppShellSnapshot = {
  byokLinkVisible: boolean;
  cloudSignInVisible: boolean;
  homeVisible: boolean;
  localLinkVisible: boolean;
  onboardingVisible: boolean;
  text: string;
  title: string;
};

export type PackagedAppShellProbeElement = {
  getClientRects(): ArrayLike<unknown>;
};

export type PackagedAppShellProbeDocument = {
  body: { textContent: string | null } | null;
  querySelector(selectors: string): PackagedAppShellProbeElement | null;
  querySelectorAll(selectors: string): Iterable<PackagedAppShellProbeElement>;
  title: string;
};

/**
 * Evaluates the shipped probe text against a fixture document.
 *
 * The probe is a string, so nothing in the normal build checks it. Running the
 * identical text here is the only way a non-Windows machine can prove that the
 * selectors, the `getClientRects` visibility rule, and the reported field set
 * still behave as the smoke expects.
 */
export function evaluatePackagedAppShellProbe(
  document: PackagedAppShellProbeDocument,
  elementConstructor: new (...args: never[]) => PackagedAppShellProbeElement,
): unknown {
  // Parenthesized deliberately: the probe text opens with a newline, and a bare
  // `return` followed by one gets an automatic semicolon.
  const probe = new Function(`return (${PACKAGED_APP_SHELL_PROBE});`)() as (
    document: PackagedAppShellProbeDocument,
    elementConstructor: unknown,
  ) => unknown;
  return probe(document, elementConstructor);
}

export function asPackagedAppShellSnapshot(value: unknown): PackagedAppShellSnapshot | null {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) return null;
  const candidate = value as Partial<PackagedAppShellSnapshot>;
  if (
    typeof candidate.byokLinkVisible !== 'boolean' ||
    typeof candidate.cloudSignInVisible !== 'boolean' ||
    typeof candidate.homeVisible !== 'boolean' ||
    typeof candidate.localLinkVisible !== 'boolean' ||
    typeof candidate.onboardingVisible !== 'boolean' ||
    typeof candidate.text !== 'string' ||
    typeof candidate.title !== 'string'
  ) {
    return null;
  }
  return candidate as PackagedAppShellSnapshot;
}

/**
 * A surface the packaged app can legitimately come to rest on.
 *
 * `home` is the signed-in/seeded main shell. `onboarding-landing` is the cloud
 * sign-in landing a first run stops at.
 */
export type PackagedAppShellState = 'home' | 'onboarding-landing';

/**
 * Which settled surface the renderer is showing, or `null` while it is showing
 * neither — a blank window, a crashed renderer, a boot still on the loader, or
 * a half-rendered onboarding shell all fall through to `null`.
 *
 * The landing is recognised positively, from the same three affordances the
 * `[P0]` onboarding smoke asserts: the sign-in CTA plus both runtime links. A
 * bare `onboardingVisible` would degrade this into "anything that is not home"
 * and stop failing on a renderer that mounted the shell and then died.
 */
export function packagedAppShellState(value: unknown): PackagedAppShellState | null {
  const snapshot = asPackagedAppShellSnapshot(value);
  if (snapshot == null) return null;
  if (snapshot.homeVisible) return 'home';
  if (
    snapshot.onboardingVisible &&
    snapshot.cloudSignInVisible &&
    snapshot.localLinkVisible &&
    snapshot.byokLinkVisible
  ) {
    return 'onboarding-landing';
  }
  return null;
}

/**
 * Reads the daemon's own onboarding-completion fact inside the packaged
 * renderer. `GET /api/app-config` serves `readAppConfig(RUNTIME_DATA_DIR)`, so
 * this reports what the running daemon resolved.
 *
 * `fetch` is taken as an argument (and wrapped at the call site, since an
 * unbound `fetch` throws in a browser) so the same text can be driven against a
 * fake in Node.
 */
const PACKAGED_ONBOARDING_CONFIG_PROBE = `
  (async (fetchImpl) => {
    try {
      const response = await fetchImpl('/api/app-config');
      const status = typeof response.status === 'number' ? response.status : null;
      if (!response.ok) return { error: 'daemon returned HTTP ' + status, ok: false, status };
      const body = await response.json();
      const config = body == null ? null : body.config;
      if (config == null || typeof config !== 'object' || Array.isArray(config)) {
        return { error: 'daemon response carried no config object', ok: false, status };
      }
      // Require the type before reading it. Coercing here (\`x === true\`) would
      // manufacture a boolean out of a missing key, a null, or the string
      // "false" — and the manufactured value is \`false\`, which is exactly the
      // reading that permits the onboarding landing. "The daemon did not tell
      // me" must never arrive as "the daemon told me false".
      if (typeof config.onboardingCompleted !== 'boolean') {
        return {
          error: 'daemon config carried no boolean onboardingCompleted (got '
            + (config.onboardingCompleted === undefined ? 'undefined' : typeof config.onboardingCompleted)
            + ')',
          ok: false,
          status,
        };
      }
      return { ok: true, onboardingCompleted: config.onboardingCompleted, status };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        ok: false,
        status: null,
      };
    }
  })
`;

export const packagedOnboardingConfigExpression = `(${PACKAGED_ONBOARDING_CONFIG_PROBE})((input) => fetch(input))`;

export type PackagedOnboardingConfigFetch = (input: string) => Promise<{
  json(): Promise<unknown>;
  ok: boolean;
  status: number;
}>;

export function evaluatePackagedOnboardingConfigProbe(
  fetchImpl: PackagedOnboardingConfigFetch,
): Promise<unknown> {
  const probe = new Function(`return (${PACKAGED_ONBOARDING_CONFIG_PROBE});`)() as (
    fetchImpl: PackagedOnboardingConfigFetch,
  ) => Promise<unknown>;
  return probe(fetchImpl);
}

/**
 * Raised when the daemon's onboarding-completion fact could not be established.
 *
 * Its own type so a caller can never mistake "we could not find out" for a
 * `false` reading.
 */
export class PackagedOnboardingConfigError extends Error {
  constructor(reason: string) {
    super(`packaged windows daemon onboarding config could not be established: ${reason}`);
    this.name = 'PackagedOnboardingConfigError';
  }
}

/**
 * The daemon's `onboardingCompleted`, or an error.
 *
 * Never returns a default. An unestablished fact must not become a permission.
 */
export function packagedOnboardingCompletedFromProbe(value: unknown): boolean {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    throw new PackagedOnboardingConfigError(
      `the probe returned no result (${JSON.stringify(value) ?? 'undefined'})`,
    );
  }
  const candidate = value as Record<string, unknown>;
  const status = typeof candidate.status === 'number' ? candidate.status : null;
  const reason = typeof candidate.error === 'string' ? candidate.error : null;

  // `status` is load-bearing, not decorative: only a 200 that actually carried a
  // config object may produce a reading. Everything else — a transport failure,
  // a non-2xx, a body without `config` — is an unestablished fact and must
  // raise, because the only alternative reading (`false`) is precisely the one
  // that would permit the onboarding landing.
  if (candidate.ok !== true) {
    throw new PackagedOnboardingConfigError(
      `${reason ?? 'the probe reported failure'} (status=${status ?? 'none'})`,
    );
  }
  if (status !== 200) {
    throw new PackagedOnboardingConfigError(`the daemon answered with status=${status ?? 'none'}`);
  }
  if (typeof candidate.onboardingCompleted !== 'boolean') {
    throw new PackagedOnboardingConfigError(
      `the daemon answered 200 without a usable reading (${JSON.stringify(candidate)})`,
    );
  }
  return candidate.onboardingCompleted;
}

export type PackagedAppShellPolicyInput = {
  /**
   * What the daemon itself reports for `onboardingCompleted`, read from
   * `GET /api/app-config` — which serves `readAppConfig(RUNTIME_DATA_DIR)`, the
   * daemon's own resolved data root.
   */
  readonly daemonOnboardingCompleted: boolean;
  /** Whether the run is the core smoke profile. */
  readonly coreProfile: boolean;
};

/**
 * Which terminal states this run may settle on.
 *
 * Derived from the daemon's own `onboardingCompleted`, never from the smoke
 * profile, so a run's setup and its accepted terminal state cannot disagree.
 * The smoke seeds `onboardingCompleted: true` before start; if the daemon
 * confirms it, the renderer must honour it and home is the only acceptable
 * outcome — that is what keeps a broken completed-onboarding boot path
 * detectable on the core release lane. Only a run whose daemon reports
 * onboarding as *not* completed is a genuine first run, and only then is the
 * cloud sign-in landing a legitimate place to stop.
 *
 * `coreProfile` still narrows it: the full profile goes on to drive the entry
 * rail, which `clickUpdaterRailExpression` refuses while onboarding is up, so
 * it needs home either way.
 */
export function packagedAppShellPolicy(
  input: PackagedAppShellPolicyInput,
): { readonly acceptOnboardingLanding: boolean } {
  // Only an explicit `false` — a daemon that positively said "not completed" —
  // buys permission. Testing for truthiness instead would let any non-boolean
  // that leaked past the type fall through to the permissive branch, which is
  // the same shape of defect as coercing the reading in the first place.
  if (input.daemonOnboardingCompleted !== false) return { acceptOnboardingLanding: false };
  return { acceptOnboardingLanding: input.coreProfile === true };
}

/**
 * Whether the renderer has reached a surface the caller can proceed from.
 *
 * `acceptOnboardingLanding` belongs to the caller because the answer depends on
 * what the smoke does next, not on what the app is allowed to show.
 */
export function packagedAppShellSettled(
  value: unknown,
  options: { readonly acceptOnboardingLanding: boolean },
): boolean {
  const state = packagedAppShellState(value);
  if (state === 'home') return true;
  // Explicit permission only, for the same reason as `packagedAppShellPolicy`.
  return state === 'onboarding-landing' && options.acceptOnboardingLanding === true;
}

/**
 * A named cause for the timeout, so a failed run points at a layer instead of
 * dumping an opaque snapshot.
 */
export function packagedAppShellFailureReason(
  value: unknown,
  options: { readonly acceptOnboardingLanding: boolean },
): string {
  const snapshot = asPackagedAppShellSnapshot(value);
  if (snapshot == null) return 'the packaged renderer returned no app-shell snapshot';
  if (packagedAppShellState(value) === 'onboarding-landing' && !options.acceptOnboardingLanding) {
    return 'the packaged renderer stopped on the onboarding cloud sign-in landing, but this smoke profile has to drive the entry rail and needs home';
  }
  if (snapshot.onboardingVisible) {
    return 'the onboarding shell mounted but its cloud sign-in landing did not render (no sign-in CTA, or fewer than two runtime links)';
  }
  return 'neither the home nav rail nor the onboarding cloud sign-in landing rendered';
}
