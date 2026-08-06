/**
 * Which coverage profile a packaged smoke run should execute.
 *
 * `core` installs, starts, inspects and uninstalls. `full` additionally drives
 * the updater, which is why it demands an explicitly wired update fixture and
 * refuses to run without one. `skip` does not run the smoke at all.
 */
export type PackagedSmokeProfile = 'core' | 'full' | 'skip';

/** Resolve the profile from the value the release workflows hand down. */
export function resolvePackagedSmokeProfile(
  raw: string | undefined | null,
): PackagedSmokeProfile {
  return (raw ?? 'core') as PackagedSmokeProfile;
}
