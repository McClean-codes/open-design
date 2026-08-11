/**
 * Host-specific command contract for filesystem agents running on Windows.
 * Keep this compact: the bundled skill supplies the detailed workflow and
 * progressive references, while this remains a fail-safe if skill discovery
 * or staging is unavailable.
 */
export const WINDOWS_POWERSHELL_SKILL_ID = 'windows-powershell';

export function shouldComposeWindowsPowerShellSkill(input: {
  hostPlatform: string | undefined;
  executionProfile: string | undefined;
}): boolean {
  return input.hostPlatform === 'win32' && input.executionProfile === 'filesystem';
}

export const WINDOWS_POWERSHELL_EXECUTION_CONTRACT = `# Windows command execution — PowerShell

This host is Windows. Every shell-tool command is parsed by PowerShell unless the tool explicitly says otherwise. The bundled \`windows-powershell\` host skill, when present below, is mandatory for shell work and routes detailed cases to progressive references.

Fail-safe rules: do not paste Bash syntax; inspect \`$PSVersionTable\` before using version-specific syntax; use \`-LiteralPath\` and argument arrays instead of command strings; check cmdlet errors and native \`$LASTEXITCODE\`; classify failures before retrying; verify every mutation with a separate read-only command.`;
