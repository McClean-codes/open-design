import { describe, expect, it } from 'vitest';

import { composeSystemPrompt } from '../../src/prompts/system.js';
import { shouldComposeWindowsPowerShellSkill } from '../../src/prompts/windows-powershell.js';

const HEADING = '# Windows command execution — PowerShell';

describe('Windows PowerShell system-prompt contract', () => {
  it.each(['classic', 'slim'] as const)(
    'injects the execution contract for Windows filesystem agents with the %s core',
    (promptCoreVariant) => {
      const prompt = composeSystemPrompt({
        agentId: 'qwen',
        executionProfile: 'filesystem',
        hostPlatform: 'win32',
        promptCoreVariant,
      });

      expect(prompt).toContain(HEADING);
      expect(prompt).toContain('Every shell-tool command is parsed by PowerShell');
      expect(prompt).toContain('$PSVersionTable');
      expect(prompt).toContain('-LiteralPath');
      expect(prompt).toContain('$LASTEXITCODE');
      expect(prompt).toContain('classify failures before retrying');
      expect(prompt).toContain('verify every mutation with a separate read-only command');
    },
  );

  it('does not inject the contract on non-Windows hosts', () => {
    const prompt = composeSystemPrompt({
      executionProfile: 'filesystem',
      hostPlatform: 'linux',
    });

    expect(prompt).not.toContain(HEADING);
  });

  it('does not inject the contract into tool-less text-artifact runs', () => {
    const prompt = composeSystemPrompt({
      executionProfile: 'text_artifact',
      hostPlatform: 'win32',
      streamFormat: 'plain',
    });

    expect(prompt).not.toContain(HEADING);
    expect(prompt).toContain('# API mode — no tools available');
  });

  it('composes the detailed host skill only for Windows filesystem runs', () => {
    expect(shouldComposeWindowsPowerShellSkill({
      hostPlatform: 'win32',
      executionProfile: 'filesystem',
    })).toBe(true);
    expect(shouldComposeWindowsPowerShellSkill({
      hostPlatform: 'linux',
      executionProfile: 'filesystem',
    })).toBe(false);
    expect(shouldComposeWindowsPowerShellSkill({
      hostPlatform: 'win32',
      executionProfile: 'text_artifact',
    })).toBe(false);
  });
});
