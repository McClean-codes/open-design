import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  runVelaCommand,
  velaWorkspaceCommandOptions,
} from '../integrations/vela-command.js';

type VelaCommandRunner = typeof runVelaCommand;
type ProgressFn = (message: string) => void;

export type VelaMediaImageRef = {
  abs: string;
};

export interface VelaImageRenderInput {
  aspect: string | undefined;
  imageRefs: VelaMediaImageRef[];
  model: string;
  prompt: string;
  wireModel: string;
  workspaceId: string | undefined;
}

export interface VelaVideoRenderInput extends VelaImageRenderInput {
  length: number | undefined;
  onProgress: ProgressFn | undefined;
}

export interface VelaRenderResult {
  bytes: Buffer;
  providerNote: string;
  suggestedExt?: string;
}

type JsonRecord = Record<string, unknown>;

const VELA_IMAGE_TIMEOUT_MS = 330_000;
const VELA_MODELS_TIMEOUT_MS = 30_000;
const VELA_VIDEO_SUBMIT_TIMEOUT_MS = 330_000;
const DEFAULT_VELA_VIDEO_POLL_COMMAND_TIMEOUT_MS = 90_000;
const DEFAULT_VELA_VIDEO_POLL_INTERVAL_MS = 5_000;
const DEFAULT_VELA_VIDEO_TOTAL_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_VELA_VIDEO_RESOLUTION = '720p';
const VELA_MAX_INPUT_IMAGES = 5;
const VELA_VIDEO_RATIOS = new Set(['16:9', '9:16', '1:1']);
const VELA_VIDEO_DURATIONS = new Set([5, 10]);

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonObject(stdout: string, command: string): JsonRecord {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`Vela ${command} returned no JSON output`);
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    if (!isRecord(value)) {
      throw new Error('expected a JSON object');
    }
    return value;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Vela ${command} returned invalid JSON: ${detail}`);
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function wireModelForVela(model: string, wireModel: string): string {
  // A configured OD alias is already the provider-facing wire name. Only
  // remove the catalogue namespace when the alias layer left the id intact.
  if (wireModel !== model) return wireModel;
  return model.startsWith('vela/') ? model.slice('vela/'.length) : model;
}

function extensionForImageMime(mime: string): string {
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/png') return '.png';
  throw new Error(`Vela image returned unsupported mime_type ${mime}`);
}

async function readNonEmptyOutput(outputPath: string, label: string): Promise<Buffer> {
  let outputStat;
  try {
    outputStat = await stat(outputPath);
  } catch {
    throw new Error(`Vela ${label} did not write the requested output file`);
  }
  if (!outputStat.isFile() || outputStat.size <= 0) {
    throw new Error(`Vela ${label} wrote an empty output file`);
  }
  return readFile(outputPath);
}

function assertInputImageCount(imageRefs: VelaMediaImageRef[]): void {
  if (imageRefs.length > VELA_MAX_INPUT_IMAGES) {
    throw new Error(
      `Vela media accepts at most ${VELA_MAX_INPUT_IMAGES} input images; received ${imageRefs.length}`,
    );
  }
}

async function stageInputImages(
  imageRefs: VelaMediaImageRef[],
  tempDir: string,
): Promise<VelaMediaImageRef[]> {
  return Promise.all(imageRefs.map(async (image, index) => {
    // Vela CLI may downscale oversized references in place before upload. A
    // project file is user data and also participates in the daemon's artifact
    // diff, so never let a transport optimization mutate the source or make an
    // untouched reference appear as this run's output.
    const extension = path.extname(image.abs);
    const staged = path.join(tempDir, `input-${index + 1}${extension}`);
    await copyFile(image.abs, staged);
    return { abs: staged };
  }));
}

// One (aspect_ratio, resolution) pair from the model's published output
// profiles. Vela publishes these per model and per request kind, and its CLI
// requires both halves together -- an aspect ratio alone is not a request.
interface VelaImageOutputProfile {
  aspectRatio: string;
  resolution: string;
}

function parsePublishedProfiles(
  stdout: string,
  model: string,
  edits: boolean,
): { profiles: VelaImageOutputProfile[]; defaultResolution: string | null } | null {
  const response = parseJsonObject(stdout, 'media models');
  const models = Array.isArray(response.models) ? response.models : [];
  const entry = models.find(
    (item): item is JsonRecord => isRecord(item) && item.model === model && item.kind === 'image',
  );
  if (!entry) return null;
  const capabilities = isRecord(entry.capabilities) ? entry.capabilities : null;
  const byRequestKind = capabilities && isRecord(capabilities.profiles) ? capabilities.profiles : null;
  const envelope = byRequestKind?.[edits ? 'edits' : 'generations'];
  if (!isRecord(envelope)) return null;
  const rawProfiles = Array.isArray(envelope.profiles) ? envelope.profiles : [];
  const profiles: VelaImageOutputProfile[] = [];
  for (const item of rawProfiles) {
    if (!isRecord(item)) continue;
    const aspectRatio = nonEmptyString(item.aspect_ratio);
    const resolution = nonEmptyString(item.resolution);
    if (aspectRatio && resolution) profiles.push({ aspectRatio, resolution });
  }
  const fallback = isRecord(envelope.default) ? nonEmptyString(envelope.default.resolution) : null;
  return { profiles, defaultResolution: fallback };
}

// Vela owns which shapes a model can actually deliver, so read the published
// profiles per request instead of caching a copy here: a catalogue that gained
// or lost a shape must take effect immediately, and one extra CLI call is
// nothing beside the generation it precedes. Returning undefined leaves the
// request without output flags, which is how the server's own default profile
// stays in charge.
async function resolveImageOutputProfile(
  input: VelaImageRenderInput,
  edits: boolean,
  wireModel: string,
  runCommand: VelaCommandRunner,
): Promise<VelaImageOutputProfile | undefined> {
  const aspect = input.aspect?.trim();
  if (!aspect) return undefined;
  const stdout = await runCommand(['media', 'models', '--json'], {
    ...velaWorkspaceCommandOptions(input.workspaceId),
    timeoutMs: VELA_MODELS_TIMEOUT_MS,
  });
  const published = parsePublishedProfiles(stdout, wireModel, edits);
  if (!published || published.profiles.length === 0) {
    throw new Error(
      `Vela model ${wireModel} does not publish output profiles, so aspect ${aspect} cannot be requested`,
    );
  }
  const matching = published.profiles.filter((profile) => profile.aspectRatio === aspect);
  if (matching.length === 0) {
    const supported = [...new Set(published.profiles.map((profile) => profile.aspectRatio))];
    throw new Error(
      `Vela model ${wireModel} does not publish aspect ${aspect}; supported: ${supported.join(', ')}`,
    );
  }
  // Several resolutions can share one aspect ratio. Prefer the one the model
  // defaults to, so asking only for a shape does not silently change quality
  // tier or price relative to an unqualified request.
  const preferred = matching.find((profile) => profile.resolution === published.defaultResolution);
  return preferred ?? matching[0];
}

function videoTaskError(task: JsonRecord): string {
  const raw = task.error;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (raw == null) return 'no provider error was returned';
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function renderVelaImage(
  input: VelaImageRenderInput,
  runCommand: VelaCommandRunner = runVelaCommand,
): Promise<VelaRenderResult> {
  assertInputImageCount(input.imageRefs);
  const wireModel = wireModelForVela(input.model, input.wireModel);
  const edits = input.imageRefs.length > 0;
  const profile = await resolveImageOutputProfile(input, edits, wireModel, runCommand);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'open-design-vela-image-'));
  const outputPath = path.join(tempDir, 'result.bin');
  try {
    const stagedImageRefs = await stageInputImages(input.imageRefs, tempDir);
    const command = edits ? 'edit' : 'gen';
    const args = [
      'image',
      command,
      '--model',
      wireModel,
      '--prompt',
      input.prompt,
      ...stagedImageRefs.flatMap((image) => ['--image', image.abs]),
      ...(profile
        ? ['--aspect-ratio', profile.aspectRatio, '--resolution', profile.resolution]
        : []),
      '--output',
      outputPath,
      '--json',
    ];
    const stdout = await runCommand(args, {
      ...velaWorkspaceCommandOptions(input.workspaceId),
      timeoutMs: VELA_IMAGE_TIMEOUT_MS,
    });
    const asset = parseJsonObject(stdout, `image ${command}`);
    const assetId = nonEmptyString(asset.asset_id);
    const status = nonEmptyString(asset.status);
    const kind = nonEmptyString(asset.kind);
    const mime = nonEmptyString(asset.mime_type);
    if (!assetId) throw new Error(`Vela image ${command} response is missing asset_id`);
    if (status !== 'ready') {
      throw new Error(`Vela image ${command} returned non-ready asset status ${status ?? 'missing'}`);
    }
    if (kind !== 'image') {
      throw new Error(`Vela image ${command} returned unexpected kind ${kind ?? 'missing'}`);
    }
    if (!mime?.startsWith('image/')) {
      throw new Error(`Vela image ${command} returned invalid mime_type ${mime ?? 'missing'}`);
    }
    const bytes = await readNonEmptyOutput(outputPath, `image ${command}`);
    return {
      bytes,
      providerNote: `vela/${wireModel} · ${
        profile ? `${profile.aspectRatio} ${profile.resolution}` : 'model default profile'
      } · ${bytes.length} bytes`,
      suggestedExt: extensionForImageMime(mime),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function renderVelaVideo(
  input: VelaVideoRenderInput,
  runCommand: VelaCommandRunner = runVelaCommand,
): Promise<VelaRenderResult> {
  assertInputImageCount(input.imageRefs);
  const ratio = input.aspect ?? '16:9';
  if (!VELA_VIDEO_RATIOS.has(ratio)) {
    throw new Error(`Vela video only supports aspect ratios 16:9, 9:16, or 1:1; received ${ratio}`);
  }
  if (input.length != null && !VELA_VIDEO_DURATIONS.has(input.length)) {
    throw new Error(`Vela video only supports durations of 5 or 10 seconds; received ${input.length}`);
  }

  const wireModel = wireModelForVela(input.model, input.wireModel);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'open-design-vela-video-'));
  const outputPath = path.join(tempDir, 'result.mp4');
  const startedAt = Date.now();
  const pollIntervalMs = positiveIntegerFromEnv(
    'OD_VELA_VIDEO_POLL_INTERVAL_MS',
    DEFAULT_VELA_VIDEO_POLL_INTERVAL_MS,
  );
  const totalTimeoutMs = positiveIntegerFromEnv(
    'OD_VELA_VIDEO_TIMEOUT_MS',
    DEFAULT_VELA_VIDEO_TOTAL_TIMEOUT_MS,
  );
  const pollCommandTimeoutMs = positiveIntegerFromEnv(
    'OD_VELA_VIDEO_POLL_COMMAND_TIMEOUT_MS',
    DEFAULT_VELA_VIDEO_POLL_COMMAND_TIMEOUT_MS,
  );
  let lastStatus = 'submitted';
  try {
    const stagedImageRefs = await stageInputImages(input.imageRefs, tempDir);
    const [firstFrame, ...references] = stagedImageRefs;
    const submitArgs = [
      'video',
      'gen',
      '--model',
      wireModel,
      '--prompt',
      input.prompt,
      '--ratio',
      ratio,
      '--resolution',
      DEFAULT_VELA_VIDEO_RESOLUTION,
      ...(input.length == null ? [] : ['--duration', String(input.length)]),
      ...(firstFrame ? ['--first-frame', firstFrame.abs] : []),
      ...references.flatMap((image) => ['--ref', image.abs]),
      '--no-wait',
      '--json',
    ];
    const submitStdout = await runCommand(submitArgs, {
      ...velaWorkspaceCommandOptions(input.workspaceId),
      timeoutMs: VELA_VIDEO_SUBMIT_TIMEOUT_MS,
    });
    const submitted = parseJsonObject(submitStdout, 'video gen');
    const taskId = nonEmptyString(submitted.task_id);
    if (!taskId) throw new Error('Vela video gen response is missing task_id');
    lastStatus = nonEmptyString(submitted.status) ?? 'queued';
    input.onProgress?.(`Vela video task ${taskId} accepted; polling status ${lastStatus}`);

    while (Date.now() - startedAt < totalTimeoutMs) {
      await wait(Math.min(pollIntervalMs, Math.max(1, totalTimeoutMs - (Date.now() - startedAt))));
      if (Date.now() - startedAt >= totalTimeoutMs) break;

      const pollStdout = await runCommand(
        ['video', 'get', taskId, '--output', outputPath, '--json'],
        {
          ...velaWorkspaceCommandOptions(input.workspaceId),
          timeoutMs: pollCommandTimeoutMs,
        },
      );
      const task = parseJsonObject(pollStdout, 'video get');
      const returnedTaskId = nonEmptyString(task.task_id);
      if (returnedTaskId !== taskId) {
        throw new Error(
          `Vela video get returned unexpected task_id ${returnedTaskId ?? 'missing'} (expected ${taskId})`,
        );
      }
      lastStatus = nonEmptyString(task.status) ?? 'missing';
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      input.onProgress?.(`Vela video status ${lastStatus}; elapsed ${elapsedSeconds}s`);

      if (lastStatus === 'succeeded') {
        const bytes = await readNonEmptyOutput(outputPath, 'video get');
        return {
          bytes,
          providerNote: `vela/${wireModel} · ${ratio} · ${input.length ?? 5}s · ${DEFAULT_VELA_VIDEO_RESOLUTION} default · ${bytes.length} bytes`,
          suggestedExt: '.mp4',
        };
      }
      if (lastStatus === 'failed' || lastStatus === 'cancelled' || lastStatus === 'canceled') {
        throw new Error(`Vela video task ended with status ${lastStatus}: ${videoTaskError(task)}`);
      }
      if (lastStatus !== 'queued' && lastStatus !== 'running') {
        throw new Error(`Vela video task returned unsupported status ${lastStatus}`);
      }
    }

    throw new Error(
      `Vela video task timed out after ${totalTimeoutMs}ms; last status ${lastStatus}`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
