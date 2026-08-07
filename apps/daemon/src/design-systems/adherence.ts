import { load } from 'cheerio';

import {
  DESIGN_SYSTEM_ADHERENCE_SCHEMA_VERSION,
  resolveDesignSystemIntentForGeneration,
  type DesignSystemAdherenceCheck,
  type DesignSystemAdherenceReport,
  type DesignSystemIntentSelection,
  type DesignSystemRuntimeBundle,
} from '@open-design/contracts';

export type DesignSystemAdherenceArtifact = {
  path: string;
  content: string;
  size: number;
  mime?: string;
};

export function validateDesignSystemAdherence(input: {
  bundle: DesignSystemRuntimeBundle;
  intent: string;
  artifacts: readonly DesignSystemAdherenceArtifact[];
  tokensCss?: string;
}): DesignSystemAdherenceReport {
  const resolution = resolveDesignSystemIntentForGeneration(input.bundle, input.intent);
  const checks: DesignSystemAdherenceCheck[] = [];

  if (resolution.action === 'request-human-confirmation') {
    checks.push({
      id: 'intent-resolution',
      status: 'needs-confirmation',
      message: resolution.reason === 'no-match'
        ? `No component is mapped to ${input.intent}; the design system requires human confirmation.`
        : `Multiple components match ${input.intent}; the design system requires human confirmation.`,
      remediation: 'Ask the user to choose an existing component or approve a documented exception before continuing.',
    });
    checks.push(validateFallbackMarker(input.artifacts, resolution.outputMarker));
    return buildReport(input.intent, resolution, input.artifacts, checks);
  }

  checks.push({
    id: 'intent-resolution',
    status: 'passed',
    message: resolution.action === 'reuse-components'
      ? `Resolved ${input.intent} to ${resolution.matches.length} declared component selection(s).`
      : `Applied the declared ${resolution.action} fallback for ${input.intent}.`,
  });

  if (resolution.action !== 'reuse-components') {
    checks.push(validateFallbackMarker(input.artifacts, resolution.outputMarker));
    checks.push(...validateTokenReferences(
      input.artifacts,
      input.tokensCss,
      input.bundle.lint.requireTokenReferences,
    ));
    checks.push(validateUnauthorizedColorLiterals(
      input.artifacts,
      input.bundle.lint.forbidUnauthorizedColorLiteralsOutsideTokenDefinitions,
    ));
    return buildReport(input.intent, resolution, input.artifacts, checks);
  }

  for (const selection of resolution.matches) {
    checks.push(validateComponentReuse(input.artifacts, selection, input.bundle.lint.requireMappedComponentReuse));
    if (selection.variant !== undefined) {
      checks.push(validateVariantReuse(input.artifacts, selection));
    }
    checks.push(...validateDeclaredStates(
      input.artifacts,
      selection,
      input.bundle.lint.requireDeclaredStates,
    ));
  }

  checks.push(...validateTokenReferences(
    input.artifacts,
    input.tokensCss,
    input.bundle.lint.requireTokenReferences,
  ));
  checks.push(validateUnauthorizedColorLiterals(
    input.artifacts,
    input.bundle.lint.forbidUnauthorizedColorLiteralsOutsideTokenDefinitions,
  ));

  return buildReport(input.intent, resolution, input.artifacts, checks);
}

function validateComponentReuse(
  artifacts: readonly DesignSystemAdherenceArtifact[],
  selection: DesignSystemIntentSelection,
  required: boolean,
): DesignSystemAdherenceCheck {
  if (!required) {
    return {
      id: 'mapped-component-reuse',
      status: 'not-applicable',
      subject: selection.component.id,
      message: 'The active design system does not require mapped component reuse.',
    };
  }

  const usage = selectorUsage(artifacts, selection.component.selectors);
  if (usage.count >= selection.minInstances) {
    return {
      id: 'mapped-component-reuse',
      status: 'passed',
      subject: selection.component.id,
      message: `Found ${usage.count} instance(s) of ${selection.component.name}; at least ${selection.minInstances} required.`,
      evidence: usage.paths,
    };
  }
  return {
    id: 'mapped-component-reuse',
    status: 'failed',
    subject: selection.component.id,
    message: `Found ${usage.count} instance(s) of ${selection.component.name}; at least ${selection.minInstances} required.`,
    remediation: `Reuse the returned ${selection.component.id} implementation and one of these selectors: ${selection.component.selectors.join(', ')}.`,
  };
}

function validateVariantReuse(
  artifacts: readonly DesignSystemAdherenceArtifact[],
  selection: DesignSystemIntentSelection,
): DesignSystemAdherenceCheck {
  const variant = selection.variant!;
  const usage = selectorUsage(artifacts, variant.selectors);
  if (usage.count > 0) {
    return {
      id: 'variant-reuse',
      status: 'passed',
      subject: `${selection.component.id}.${variant.id}`,
      message: `Found the declared ${variant.id} variant.`,
      evidence: usage.paths,
    };
  }
  return {
    id: 'variant-reuse',
    status: 'failed',
    subject: `${selection.component.id}.${variant.id}`,
    message: `The declared ${variant.id} variant was not found in the generated artifacts.`,
    remediation: `Apply one of these variant selectors: ${variant.selectors.join(', ')}.`,
  };
}

function validateDeclaredStates(
  artifacts: readonly DesignSystemAdherenceArtifact[],
  selection: DesignSystemIntentSelection,
  required: boolean,
): DesignSystemAdherenceCheck[] {
  if (!required) {
    return [{
      id: 'declared-state',
      status: 'not-applicable',
      subject: selection.component.id,
      message: 'The active design system does not require declared state coverage.',
    }];
  }
  if (selection.states.length === 0) {
    return [{
      id: 'declared-state',
      status: 'not-applicable',
      subject: selection.component.id,
      message: 'This component selection declares no required states.',
    }];
  }

  return selection.states.map((state) => {
    const staticSelectors = state.selectors.filter((selector) => !hasPseudoSelector(selector));
    const usage = selectorUsage(artifacts, staticSelectors);
    const cssEvidence = artifacts
      .filter((artifact) => state.selectors.some((selector) =>
        hasPseudoSelector(selector) && hasCssRule(artifact.content, selector)))
      .map((artifact) => artifact.path);
    const evidence = unique([...usage.paths, ...cssEvidence]);
    if (usage.count > 0 || cssEvidence.length > 0) {
      return {
        id: 'declared-state',
        status: 'passed',
        subject: `${selection.component.id}.${state.id}`,
        message: `Found the declared ${state.id} state.`,
        evidence,
      };
    }
    return {
      id: 'declared-state',
      status: 'failed',
      subject: `${selection.component.id}.${state.id}`,
      message: `The declared ${state.id} state is missing.`,
      remediation: `Implement one of these state selectors: ${state.selectors.join(', ')}.`,
    };
  });
}

function hasPseudoSelector(selector: string): boolean {
  return /:{1,2}[A-Za-z-]+/u.test(selector);
}

function validateTokenReferences(
  artifacts: readonly DesignSystemAdherenceArtifact[],
  tokensCss: string | undefined,
  required: boolean,
): DesignSystemAdherenceCheck[] {
  if (!required) {
    return [{
      id: 'token-reference',
      status: 'not-applicable',
      message: 'The active design system does not require token references.',
    }];
  }

  const references = collectMatches(artifacts, /var\(\s*(--[A-Za-z0-9_-]+)/gu, 1);
  const declared = new Set(matchAll(tokensCss ?? '', /(--[A-Za-z0-9_-]+)\s*:/gu, 1));
  const checks: DesignSystemAdherenceCheck[] = [];
  if (declared.size === 0) {
    checks.push({
      id: 'token-reference',
      status: 'failed',
      message: 'The structured design-system package has no readable token definitions.',
      remediation: 'Restore the manifest-declared tokens.css before relying on structured generation.',
    });
    return checks;
  }

  if (references.values.length === 0) {
    checks.push({
      id: 'token-reference',
      status: 'failed',
      message: 'No design-token references were found in the generated artifacts.',
      remediation: 'Replace repeated visual literals with var(--token-name) references from the active tokens.css.',
    });
  } else {
    checks.push({
      id: 'token-reference',
      status: 'passed',
      message: `Found ${references.values.length} design-token reference(s).`,
      evidence: references.paths,
    });
  }

  const unauthorized = unique(references.values.filter((token) => !declared.has(token)));
  checks.push(unauthorized.length === 0
    ? {
        id: 'unauthorized-token-reference',
        status: 'passed',
        message: 'Every referenced token is declared by the active design system.',
      }
    : {
        id: 'unauthorized-token-reference',
        status: 'failed',
        message: `Found undeclared token reference(s): ${unauthorized.join(', ')}.`,
        remediation: 'Use a declared token or add the missing token to the design system before using it.',
        evidence: references.paths,
      });
  return checks;
}

function validateUnauthorizedColorLiterals(
  artifacts: readonly DesignSystemAdherenceArtifact[],
  forbidden: boolean,
): DesignSystemAdherenceCheck {
  if (!forbidden) {
    return {
      id: 'unauthorized-color-literal',
      status: 'not-applicable',
      message: 'The active design system allows color literals outside token definitions.',
    };
  }

  const findings = artifacts.flatMap((artifact) =>
    findColorLiteralsOutsideTokenDefinitions(visualStyleSource(artifact)).map((value) => ({
      path: artifact.path,
      value,
    })),
  );
  if (findings.length === 0) {
    return {
      id: 'unauthorized-color-literal',
      status: 'passed',
      message: 'No color literals were found outside token definitions.',
    };
  }
  return {
    id: 'unauthorized-color-literal',
    status: 'failed',
    message: `Found unauthorized color literal(s): ${unique(findings.map((finding) => finding.value)).join(', ')}.`,
    remediation: 'Move the value into the token definition block or replace it with a declared var(--token-name) reference.',
    evidence: unique(findings.map((finding) => finding.path)),
  };
}

function validateFallbackMarker(
  artifacts: readonly DesignSystemAdherenceArtifact[],
  marker: string | undefined,
): DesignSystemAdherenceCheck {
  if (marker === undefined) {
    return {
      id: 'fallback-marker',
      status: 'not-applicable',
      message: 'The selected fallback does not declare an output marker.',
    };
  }
  const paths = artifacts.filter((artifact) => artifact.content.includes(marker)).map((artifact) => artifact.path);
  if (paths.length > 0) {
    return {
      id: 'fallback-marker',
      status: 'passed',
      message: `Found the declared fallback marker ${marker}.`,
      evidence: paths,
    };
  }
  return {
    id: 'fallback-marker',
    status: 'failed',
    message: `The declared fallback marker ${marker} is missing.`,
    remediation: 'Add the exact marker to the placeholder or pending-confirmation output before requesting review.',
  };
}

function buildReport(
  intent: string,
  resolution: DesignSystemAdherenceReport['resolution'],
  artifacts: readonly DesignSystemAdherenceArtifact[],
  checks: DesignSystemAdherenceCheck[],
): DesignSystemAdherenceReport {
  const summary = {
    passed: checks.filter((check) => check.status === 'passed').length,
    failed: checks.filter((check) => check.status === 'failed').length,
    needsConfirmation: checks.filter((check) => check.status === 'needs-confirmation').length,
    notApplicable: checks.filter((check) => check.status === 'not-applicable').length,
  };
  const status = summary.failed > 0
    ? 'failed'
    : summary.needsConfirmation > 0
      ? 'confirmation-required'
      : 'passed';
  return {
    schemaVersion: DESIGN_SYSTEM_ADHERENCE_SCHEMA_VERSION,
    intent,
    status,
    nextAction: status === 'failed'
      ? 'fix-and-rerun'
      : status === 'confirmation-required'
        ? 'request-human-confirmation'
        : 'complete',
    resolution,
    artifacts: artifacts.map((artifact) => ({
      path: artifact.path,
      size: artifact.size,
      ...(artifact.mime === undefined ? {} : { mime: artifact.mime }),
    })),
    summary,
    checks,
  };
}

function selectorUsage(
  artifacts: readonly DesignSystemAdherenceArtifact[],
  selectors: readonly string[],
): { count: number; paths: string[] } {
  let count = 0;
  const paths: string[] = [];
  for (const artifact of artifacts) {
    if (!looksLikeMarkup(artifact.path, artifact.mime)) continue;
    const artifactCount = countSelectorMatches(artifact.content, selectors);
    if (artifactCount === 0) continue;
    count += artifactCount;
    paths.push(artifact.path);
  }
  return { count, paths };
}

function countSelectorMatches(source: string, selectors: readonly string[]): number {
  try {
    const $ = load(source);
    const selectable = selectors.filter((selector) => !selector.includes(':'));
    if (selectable.length > 0) {
      const parsedCount = $(selectable.join(', ')).length;
      if (parsedCount > 0) return parsedCount;
    }
  } catch {
    // JSX, Vue, or partially generated HTML may not parse as strict selectors.
  }

  const tokens = uniqueByKey(selectors.flatMap(selectorIdentityTokens), (token) => `${token.kind}:${token.value}`);
  if (tokens.length === 0 || !tokens.every((token) => identityPattern(token).test(source))) return 0;
  const primary = tokens[0]!;
  return [...source.matchAll(identityPattern(primary, true))].length;
}

type SelectorIdentity = { kind: 'class' | 'id' | 'attribute'; value: string };

function selectorIdentityTokens(selector: string): SelectorIdentity[] {
  const out: SelectorIdentity[] = [];
  for (const match of selector.matchAll(/\.([_A-Za-z][_A-Za-z0-9-]*)/gu)) {
    out.push({ kind: 'class', value: match[1]! });
  }
  for (const match of selector.matchAll(/#([_A-Za-z][_A-Za-z0-9-]*)/gu)) {
    out.push({ kind: 'id', value: match[1]! });
  }
  for (const match of selector.matchAll(/\[([A-Za-z_:][A-Za-z0-9_:.-]*)/gu)) {
    out.push({ kind: 'attribute', value: match[1]! });
  }
  return out;
}

function identityPattern(identity: SelectorIdentity, global = false): RegExp {
  const flag = global ? 'gu' : 'u';
  const value = escapeRegExp(identity.value);
  if (identity.kind === 'class') {
    return new RegExp(`(?:class|className)\\s*=\\s*(?:["'][^"']*\\b${value}(?![A-Za-z0-9_-])|\\{[^}]*["'][^"']*\\b${value}(?![A-Za-z0-9_-]))`, flag);
  }
  if (identity.kind === 'id') {
    return new RegExp(`\\bid\\s*=\\s*(?:["']${value}["']|\\{["']${value}["']\\})`, flag);
  }
  return new RegExp(`(?:\\b${value}\\s*=|\\{\\.\.\.[^}]*\\b${value}\\b)`, flag);
}

function hasCssRule(source: string, selector: string): boolean {
  const normalizedSelector = normalizeCssSelector(selector);
  for (const match of stripComments(source).matchAll(/([^{}]+)\{/gu)) {
    const prelude = match[1] ?? '';
    if (prelude.includes(':root') && prelude.includes('--')) continue;
    if (prelude.split(',').some((candidate) => normalizeCssSelector(candidate) === normalizedSelector)) {
      return true;
    }
  }
  return false;
}

function normalizeCssSelector(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function findColorLiteralsOutsideTokenDefinitions(source: string): string[] {
  const withoutComments = stripComments(source);
  const withoutTokenDefinitions = withoutComments.replace(/--[A-Za-z0-9_-]+\s*:\s*[^;{}]+;?/gu, '');
  const colorPattern = /#[0-9A-Fa-f]{8}(?![0-9A-Fa-f])|#[0-9A-Fa-f]{6}(?![0-9A-Fa-f])|#[0-9A-Fa-f]{4}(?![0-9A-Fa-f])|#[0-9A-Fa-f]{3}(?![0-9A-Fa-f])|\b(?:rgba?|hsla?|lab|lch|oklab|oklch|color)\([^)]*\)/gu;
  return unique([...withoutTokenDefinitions.matchAll(colorPattern)].map((match) => match[0]!));
}

function visualStyleSource(artifact: DesignSystemAdherenceArtifact): string {
  if (/\.css$/iu.test(artifact.path) || artifact.mime === 'text/css') return artifact.content;
  if (!/\.(?:html?|svg)$/iu.test(artifact.path) && artifact.mime?.includes('html') !== true) {
    return artifact.content;
  }
  try {
    const $ = load(artifact.content);
    const parts: string[] = [];
    $('style').each((_index, element) => {
      parts.push($(element).text());
    });
    $('[style], [fill], [stroke], [color], [bgcolor]').each((_index, element) => {
      for (const attribute of ['style', 'fill', 'stroke', 'color', 'bgcolor']) {
        const value = $(element).attr(attribute);
        if (value !== undefined) parts.push(value);
      }
    });
    return parts.join('\n');
  } catch {
    return artifact.content;
  }
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/<!--([\s\S]*?)-->/gu, '');
}

function collectMatches(
  artifacts: readonly DesignSystemAdherenceArtifact[],
  pattern: RegExp,
  group: number,
): { values: string[]; paths: string[] } {
  const values: string[] = [];
  const paths: string[] = [];
  for (const artifact of artifacts) {
    const matches = matchAll(artifact.content, pattern, group);
    if (matches.length === 0) continue;
    values.push(...matches);
    paths.push(artifact.path);
  }
  return { values, paths: unique(paths) };
}

function matchAll(source: string, pattern: RegExp, group: number): string[] {
  return [...source.matchAll(pattern)].flatMap((match) => match[group] === undefined ? [] : [match[group]!]);
}

function looksLikeMarkup(filePath: string, mime: string | undefined): boolean {
  return mime?.includes('html') === true
    || /\.(?:html?|svg|jsx|tsx|vue|svelte)$/iu.test(filePath);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function uniqueByKey<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const itemKey = key(value);
    if (seen.has(itemKey)) return false;
    seen.add(itemKey);
    return true;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
