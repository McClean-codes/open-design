import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runVelaCommandMock } = vi.hoisted(() => ({
  runVelaCommandMock: vi.fn(),
}));

vi.mock('../../src/integrations/vela-command.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/integrations/vela-command.js')>();
  return {
    ...actual,
    runVelaCommand: runVelaCommandMock,
  };
});

import { generateMedia } from '../../src/media/index.js';

const IMAGE_BYTES = Buffer.from('real-image-output');
const VIDEO_BYTES = Buffer.from('real-video-output');

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) throw new Error(`missing ${flag}`);
  return args[index + 1]!;
}

function allValuesAfter(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === flag && args[index + 1]) values.push(args[index + 1]!);
  }
  return values;
}

describe('Vela media provider', () => {
  let root: string;
  let projectRoot: string;
  let projectsRoot: string;
  let projectDir: string;
  let refs: string[];
  let tempOutputDirs: string[];
  const originalAliases = process.env.OD_MEDIA_MODEL_ALIASES;
  const originalStubs = process.env.OD_MEDIA_ALLOW_STUBS;
  const originalPoll = process.env.OD_VELA_VIDEO_POLL_INTERVAL_MS;
  const originalVideoTimeout = process.env.OD_VELA_VIDEO_TIMEOUT_MS;

  beforeEach(async () => {
    runVelaCommandMock.mockReset();
    root = await mkdtemp(path.join(os.tmpdir(), 'od-vela-media-test-'));
    projectRoot = path.join(root, 'repo');
    projectsRoot = path.join(projectRoot, '.od', 'projects');
    projectDir = path.join(projectsRoot, 'project-1');
    await mkdir(projectDir, { recursive: true });
    refs = [];
    for (let index = 1; index <= 6; index++) {
      const name = `ref-${index}.png`;
      await writeFile(path.join(projectDir, name), Buffer.from(`image-${index}`));
      refs.push(name);
    }
    tempOutputDirs = [];
    delete process.env.OD_MEDIA_MODEL_ALIASES;
    delete process.env.OD_MEDIA_ALLOW_STUBS;
    process.env.OD_VELA_VIDEO_POLL_INTERVAL_MS = '1';
    process.env.OD_VELA_VIDEO_TIMEOUT_MS = '1000';
  });

  afterEach(async () => {
    if (originalAliases == null) delete process.env.OD_MEDIA_MODEL_ALIASES;
    else process.env.OD_MEDIA_MODEL_ALIASES = originalAliases;
    if (originalStubs == null) delete process.env.OD_MEDIA_ALLOW_STUBS;
    else process.env.OD_MEDIA_ALLOW_STUBS = originalStubs;
    if (originalPoll == null) delete process.env.OD_VELA_VIDEO_POLL_INTERVAL_MS;
    else process.env.OD_VELA_VIDEO_POLL_INTERVAL_MS = originalPoll;
    if (originalVideoTimeout == null) delete process.env.OD_VELA_VIDEO_TIMEOUT_MS;
    else process.env.OD_VELA_VIDEO_TIMEOUT_MS = originalVideoTimeout;
    await rm(root, { recursive: true, force: true });
  });

  function baseArgs() {
    return {
      projectRoot,
      projectsRoot,
      projectId: 'project-1',
      prompt: 'A precise test prompt',
    };
  }

  function mockReadyImage(mime = 'image/webp') {
    runVelaCommandMock.mockImplementation(async (args: string[]) => {
      const output = valueAfter(args, '--output');
      tempOutputDirs.push(path.dirname(output));
      await writeFile(output, IMAGE_BYTES);
      return JSON.stringify({
        asset_id: 'ma_test',
        status: 'ready',
        kind: 'image',
        mime_type: mime,
      });
    });
  }

  it('maps vela catalogue id to image gen, preserves aliasing, and injects trusted workspace env', async () => {
    process.env.OD_MEDIA_MODEL_ALIASES = JSON.stringify({
      'vela/gpt-image-2': 'tenant-image-model',
    });
    mockReadyImage();

    const result = await generateMedia({
      ...baseArgs(),
      surface: 'image',
      model: 'vela/gpt-image-2',
      output: 'poster.png',
      aspect: '1:1',
      workspaceId: 'workspace-team',
    });

    expect(result.providerId).toBe('vela');
    expect(result.usedStubFallback).toBe(false);
    expect(result.name).toBe('poster.webp');
    expect(result.providerNote).toContain('vela/tenant-image-model');
    const [args, options] = runVelaCommandMock.mock.calls[0]!;
    expect(args.slice(0, 2)).toEqual(['image', 'gen']);
    expect(valueAfter(args, '--model')).toBe('tenant-image-model');
    expect(args).not.toContain('--size');
    expect(options.timeoutMs).toBe(330_000);
    expect(options.configuredEnv).toEqual({
      VELA_INVOCATION_SOURCE: 'open-design',
      VELA_WORKSPACE_ID: 'workspace-team',
    });
    await expect(stat(tempOutputDirs[0]!)).rejects.toThrow();
  });

  it('uses image edit with five absolute, independently repeated --image values', async () => {
    mockReadyImage('image/png');

    await generateMedia({
      ...baseArgs(),
      surface: 'image',
      model: 'vela/nano-banana-2',
      images: refs.slice(0, 5),
      output: 'edited.png',
    });

    const [args, options] = runVelaCommandMock.mock.calls[0]!;
    expect(args.slice(0, 2)).toEqual(['image', 'edit']);
    expect(valueAfter(args, '--model')).toBe('nano-banana-2');
    expect(allValuesAfter(args, '--image')).toEqual(
      refs.slice(0, 5).map((name) => path.join(projectDir, name)),
    );
    expect(options.configuredEnv).toEqual({
      VELA_INVOCATION_SOURCE: 'open-design',
    });
  });

  it('rejects six images before spawning Vela', async () => {
    await expect(generateMedia({
      ...baseArgs(),
      surface: 'image',
      model: 'vela/seedream-5.0',
      images: refs,
      output: 'too-many.png',
    })).rejects.toThrow('at most 5 input images');
    expect(runVelaCommandMock).not.toHaveBeenCalled();
  });

  it('rejects an unproven non-default image aspect before spawning Vela', async () => {
    await expect(generateMedia({
      ...baseArgs(),
      surface: 'image',
      model: 'vela/seedream-5.0-pro',
      aspect: '16:9',
      output: 'wrong-aspect.png',
    })).rejects.toThrow('does not advertise a proven size');
    expect(runVelaCommandMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      'invalid JSON',
      async (args: string[]) => {
        tempOutputDirs.push(path.dirname(valueAfter(args, '--output')));
        return 'not-json';
      },
      'invalid JSON',
    ],
    [
      'non-ready asset',
      async (args: string[]) => {
        const output = valueAfter(args, '--output');
        tempOutputDirs.push(path.dirname(output));
        await writeFile(output, IMAGE_BYTES);
        return JSON.stringify({ asset_id: 'ma_wait', status: 'processing', kind: 'image', mime_type: 'image/png' });
      },
      'non-ready asset status processing',
    ],
    [
      'missing output',
      async (args: string[]) => {
        tempOutputDirs.push(path.dirname(valueAfter(args, '--output')));
        return JSON.stringify({ asset_id: 'ma_missing', status: 'ready', kind: 'image', mime_type: 'image/png' });
      },
      'did not write the requested output file',
    ],
    [
      'empty output',
      async (args: string[]) => {
        const output = valueAfter(args, '--output');
        tempOutputDirs.push(path.dirname(output));
        await writeFile(output, Buffer.alloc(0));
        return JSON.stringify({ asset_id: 'ma_empty', status: 'ready', kind: 'image', mime_type: 'image/png' });
      },
      'wrote an empty output file',
    ],
  ])('fails on %s and cleans the daemon temp directory', async (_name, implementation, message) => {
    runVelaCommandMock.mockImplementation(implementation);
    await expect(generateMedia({
      ...baseArgs(),
      surface: 'image',
      model: 'vela/gpt-image-2',
      output: 'broken.png',
    })).rejects.toThrow(message);
    if (tempOutputDirs[0]) {
      await expect(stat(tempOutputDirs[0])).rejects.toThrow();
    }
  });

  it('never turns a Vela failure into a stub, even when stubs are enabled', async () => {
    process.env.OD_MEDIA_ALLOW_STUBS = '1';
    runVelaCommandMock.mockImplementation(async (args: string[]) => {
      tempOutputDirs.push(path.dirname(valueAfter(args, '--output')));
      throw new Error('workspace billing denied');
    });

    await expect(generateMedia({
      ...baseArgs(),
      surface: 'image',
      model: 'vela/gpt-image-2',
      output: 'must-not-exist.png',
    })).rejects.toThrow('workspace billing denied');
    await expect(stat(path.join(projectDir, 'must-not-exist.png'))).rejects.toThrow();
    await expect(stat(tempOutputDirs[0]!)).rejects.toThrow();
  });

  it('submits and polls video with first-frame/references, progress heartbeats, and one terminal download', async () => {
    const progress: string[] = [];
    runVelaCommandMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'video' && args[1] === 'gen') {
        return JSON.stringify({ task_id: 'mt_test', status: 'queued' });
      }
      const output = valueAfter(args, '--output');
      tempOutputDirs.push(path.dirname(output));
      const pollIndex = runVelaCommandMock.mock.calls.filter(
        ([callArgs]) => callArgs[0] === 'video' && callArgs[1] === 'get',
      ).length;
      if (pollIndex === 1) {
        return JSON.stringify({ task_id: 'mt_test', status: 'running', progress: 0.5 });
      }
      await writeFile(output, VIDEO_BYTES);
      return JSON.stringify({ task_id: 'mt_test', status: 'succeeded' });
    });

    const result = await generateMedia({
      ...baseArgs(),
      surface: 'video',
      model: 'vela/doubao-seedance-2-0-260128',
      aspect: '9:16',
      length: 10,
      images: refs.slice(0, 5),
      output: 'clip.mov',
      onProgress: (line) => progress.push(line),
      workspaceId: 'workspace-video',
    });

    expect(result.providerId).toBe('vela');
    expect(result.name).toBe('clip.mp4');
    expect(result.providerNote).not.toContain('mt_test');
    const submit = runVelaCommandMock.mock.calls[0]![0] as string[];
    expect(submit.slice(0, 2)).toEqual(['video', 'gen']);
    expect(submit).toContain('--no-wait');
    expect(submit).not.toContain('--wait');
    expect(submit).not.toContain('--output');
    expect(valueAfter(submit, '--model')).toBe('doubao-seedance-2-0-260128');
    expect(valueAfter(submit, '--ratio')).toBe('9:16');
    expect(valueAfter(submit, '--duration')).toBe('10');
    expect(valueAfter(submit, '--first-frame')).toBe(path.join(projectDir, refs[0]!));
    expect(allValuesAfter(submit, '--ref')).toEqual(
      refs.slice(1, 5).map((name) => path.join(projectDir, name)),
    );
    expect(valueAfter(submit, '--resolution')).toBe('720p');
    expect(submit).not.toContain('--generate-audio');

    const polls = runVelaCommandMock.mock.calls.slice(1).map(([args]) => args as string[]);
    expect(polls).toHaveLength(2);
    for (const poll of polls) {
      expect(poll.slice(0, 3)).toEqual(['video', 'get', 'mt_test']);
      expect(poll).toContain('--output');
      expect(poll).toContain('--json');
      expect(poll).not.toContain('--wait');
    }
    expect(progress[0]).toContain('accepted');
    expect(progress.some((line) => line.includes('status running'))).toBe(true);
    expect(progress.some((line) => line.includes('status succeeded'))).toBe(true);
    await expect(stat(tempOutputDirs.at(-1)!)).rejects.toThrow();
  });

  it('preserves a failed video status and provider error', async () => {
    runVelaCommandMock
      .mockResolvedValueOnce(JSON.stringify({ task_id: 'mt_failed', status: 'queued' }))
      .mockResolvedValueOnce(JSON.stringify({
        task_id: 'mt_failed',
        status: 'failed',
        error: { code: 'provider_rejected', message: 'unsafe reference' },
      }));

    await expect(generateMedia({
      ...baseArgs(),
      surface: 'video',
      model: 'vela/doubao-seedance-2-0-260128',
      length: 5,
      output: 'failed.mp4',
    })).rejects.toThrow(/status failed.*provider_rejected.*unsafe reference/);
  });

  it('times out with the last video status and cleans temporary output', async () => {
    process.env.OD_VELA_VIDEO_TIMEOUT_MS = '3';
    runVelaCommandMock
      .mockResolvedValueOnce(JSON.stringify({ task_id: 'mt_slow', status: 'queued' }))
      .mockImplementation(async (args: string[]) => {
        tempOutputDirs.push(path.dirname(valueAfter(args, '--output')));
        return JSON.stringify({ task_id: 'mt_slow', status: 'running' });
      });

    await expect(generateMedia({
      ...baseArgs(),
      surface: 'video',
      model: 'vela/doubao-seedance-2-0-260128',
      output: 'slow.mp4',
    })).rejects.toThrow(/timed out.*last status (queued|running)/);
    if (tempOutputDirs[0]) {
      await expect(stat(tempOutputDirs[0])).rejects.toThrow();
    }
  });

  it.each([
    ['4:3', 5, 'only supports aspect ratios'],
    ['16:9', 6, 'only supports durations of 5 or 10'],
    ['16:9', 8, 'only supports durations of 5 or 10'],
  ])('rejects unsupported video capability %s/%ss before spawning', async (aspect, length, message) => {
    await expect(generateMedia({
      ...baseArgs(),
      surface: 'video',
      model: 'vela/doubao-seedance-2-0-260128',
      aspect,
      length,
      output: 'unsupported.mp4',
    })).rejects.toThrow(message);
    expect(runVelaCommandMock).not.toHaveBeenCalled();
  });
});
