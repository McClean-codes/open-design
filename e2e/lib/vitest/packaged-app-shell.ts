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
 */
export function packagedAppShellState(value: unknown): PackagedAppShellState | null {
  const snapshot = asPackagedAppShellSnapshot(value);
  if (snapshot == null) return null;
  if (snapshot.homeVisible) return 'home';
  return null;
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
  return state === 'onboarding-landing' && options.acceptOnboardingLanding;
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
