import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const skillRoot = path.join(repoRoot, 'skills', 'windows-powershell');
const checkerPath = path.join(skillRoot, 'scripts', 'Test-PowerShellSyntax.ps1');
const testPath = path.join(skillRoot, 'tests', 'Test-PowerShellSyntax.Tests.ps1');

const sideFiles = [
  'references/quoting-and-parsing.md',
  'references/native-commands.md',
  'references/ps51-vs-pwsh7.md',
  'references/encoding-and-json.md',
  'references/failure-recovery.md',
  'scripts/Test-PowerShellSyntax.ps1',
  'tests/fixtures/valid-ps51.ps1',
  'tests/fixtures/valid-ps7.ps1',
  'tests/fixtures/invalid-parser.ps1',
] as const;

function availablePowerShellEngines(): string[] {
  return ['pwsh', 'powershell.exe'].filter((engine) => {
    const probe = spawnSync(
      engine,
      ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
      { encoding: 'utf8' },
    );
    return probe.status === 0;
  });
}

describe('windows-powershell skill bundle', () => {
  it('keeps the core contract compact and routes detailed topics to side files', async () => {
    const skill = await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');

    expect(skill).toContain('name: windows-powershell');
    expect(skill).toContain('mode: utility');
    expect(skill).toContain('$PSVersionTable.PSVersion');
    expect(skill).toContain('$LASTEXITCODE');
    expect(skill).toContain('Never build');
    expect(skill).toContain('Invoke-Expression');
    expect(skill).toContain('separate read-only command');
    for (const sideFile of sideFiles) {
      const info = await stat(path.join(skillRoot, sideFile));
      expect(info.isFile(), `${sideFile} must be a regular file`).toBe(true);
      if (sideFile.startsWith('references/') || sideFile.startsWith('scripts/')) {
        expect(skill).toContain(sideFile);
      }
    }
  });

  it('uses the PowerShell Parser API without executing the inspected script', async () => {
    const checker = await readFile(checkerPath, 'utf8');

    expect(checker).toContain('System.Management.Automation.Language.Parser');
    expect(checker).toContain('::ParseFile(');
    expect(checker).not.toContain('Invoke-Expression');
    expect(checker).not.toContain('Write-Error');
    expect(checker).not.toMatch(/&\s+\$item\.FullName/);
  });

  const engines = availablePowerShellEngines();
  it.skipIf(engines.length === 0)(
    'accepts shared syntax and classifies version-specific parser failures in installed engines',
    () => {
      for (const engine of engines) {
        const result = spawnSync(
          engine,
          ['-NoProfile', '-NonInteractive', '-File', testPath],
          { encoding: 'utf8' },
        );

        expect(
          { engine, status: result.status, stdout: result.stdout, stderr: result.stderr },
          `${engine} syntax-check suite failed`,
        ).toMatchObject({ status: 0 });
      }
    },
  );
});
