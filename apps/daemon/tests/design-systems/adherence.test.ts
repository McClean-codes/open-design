import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateDesignSystemAdherence } from '../../src/design-systems/adherence.js';
import { loadDesignSystemRuntimePackage } from '../../src/design-systems/runtime.js';

const fixtureRoot = path.resolve(import.meta.dirname, '../fixtures/design-systems/runtime-v3');
const runtimePaths = {
  components: 'manifests/components.json',
  intents: 'manifests/intent-map.json',
  lint: 'rules/lint.json',
  fallback: 'rules/fallback.json',
} as const;

async function loadBundle() {
  const runtime = await loadDesignSystemRuntimePackage(fixtureRoot, runtimePaths);
  if (runtime.mode !== 'structured') throw new Error(`expected structured fixture, got ${runtime.mode}`);
  return runtime.bundle;
}

describe('design-system adherence validation', () => {
  it('checks component, variant, state, and token reuse across related files', async () => {
    const report = validateDesignSystemAdherence({
      bundle: await loadBundle(),
      intent: 'account.settings.save',
      tokensCss: ':root { --accent: #245cff; }',
      artifacts: [
        {
          path: 'account-settings.html',
          mime: 'text/html',
          size: 86,
          content: '<button class="button button--primary">Save changes</button>',
        },
        {
          path: 'account-settings.css',
          mime: 'text/css',
          size: 220,
          content: `:root { --accent: #245cff; }
            .button { color: var(--accent); }
            .button--primary:hover { opacity: .9; }
            .button:focus-visible { outline: 2px solid var(--accent); }`,
        },
      ],
    });

    expect(report.status).toBe('passed');
    expect(report.nextAction).toBe('complete');
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'mapped-component-reuse', status: 'passed' }),
      expect.objectContaining({ id: 'variant-reuse', status: 'passed' }),
      expect.objectContaining({ id: 'declared-state', subject: 'Button.hover', status: 'passed' }),
      expect.objectContaining({ id: 'declared-state', subject: 'Button.focus', status: 'passed' }),
      expect.objectContaining({ id: 'unauthorized-token-reference', status: 'passed' }),
    ]));
  });

  it('fails a near-copy and returns concrete remediation', async () => {
    const report = validateDesignSystemAdherence({
      bundle: await loadBundle(),
      intent: 'account.settings.save',
      tokensCss: ':root { --accent: #245cff; }',
      artifacts: [{
        path: 'account-settings.html',
        mime: 'text/html',
        size: 90,
        content: '<button class="save-action" style="color: #123">Save changes</button>',
      }],
    });

    expect(report.status).toBe('failed');
    expect(report.nextAction).toBe('fix-and-rerun');
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'mapped-component-reuse',
        status: 'failed',
        remediation: expect.stringContaining('.button'),
      }),
      expect.objectContaining({
        id: 'unauthorized-color-literal',
        status: 'failed',
        message: expect.stringContaining('#123'),
      }),
    ]));
  });

  it('does not treat a base component class as proof that its interaction states exist', async () => {
    const report = validateDesignSystemAdherence({
      bundle: await loadBundle(),
      intent: 'account.settings.save',
      tokensCss: ':root { --accent: #245cff; }',
      artifacts: [{
        path: 'account-settings.html',
        mime: 'text/html',
        size: 160,
        content: '<style>.button { color: var(--accent); }</style><button class="button button--primary">Save changes</button>',
      }],
    });

    expect(report.status).toBe('failed');
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'declared-state', subject: 'Button.hover', status: 'failed' }),
      expect.objectContaining({ id: 'declared-state', subject: 'Button.focus', status: 'failed' }),
    ]));
  });

  it('recognizes declared classes in component source files without counting tag names as reuse', async () => {
    const report = validateDesignSystemAdherence({
      bundle: await loadBundle(),
      intent: 'account.settings.save',
      tokensCss: ':root { --accent: #245cff; }',
      artifacts: [{
        path: 'AccountSettings.tsx',
        mime: 'text/plain',
        size: 260,
        content: `export function AccountSettings() {
          return <button className="button button--primary">Save changes</button>;
        }
        const css = \`:root { --accent: #245cff; }
          .button { color: var(--accent); }
          .button--primary:hover { opacity: .9; }
          .button:focus-visible { outline: 2px solid var(--accent); }\`;`,
      }],
    });

    expect(report.status).toBe('passed');
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'mapped-component-reuse', status: 'passed' }),
      expect.objectContaining({ id: 'variant-reuse', status: 'passed' }),
    ]));
  });

  it('keeps no-match output blocked until its marker and human confirmation exist', async () => {
    const missingMarker = validateDesignSystemAdherence({
      bundle: await loadBundle(),
      intent: 'workspace.delete.confirm',
      tokensCss: ':root { --accent: #245cff; }',
      artifacts: [{ path: 'delete.html', size: 20, content: '<div>Delete</div>' }],
    });
    expect(missingMarker).toMatchObject({
      status: 'failed',
      nextAction: 'fix-and-rerun',
    });

    const marked = validateDesignSystemAdherence({
      bundle: await loadBundle(),
      intent: 'workspace.delete.confirm',
      tokensCss: ':root { --accent: #245cff; }',
      artifacts: [{
        path: 'delete.html',
        size: 70,
        content: '<div data-ds-fallback="no-match">Pending component choice</div>',
      }],
    });
    expect(marked).toMatchObject({
      status: 'confirmation-required',
      nextAction: 'request-human-confirmation',
      summary: { failed: 0, needsConfirmation: 1 },
    });
  });
});
