import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ByokChatProviderConfig,
  ByokCredentialProfile,
  UpsertByokCredentialProfileRequest,
} from '@open-design/contracts';
import {
  isNodePtyUnavailableError,
  loadNodePty,
} from '../services/node-pty.js';
import {
  WindowsDpapiWorker,
  WindowsDpapiWorkerError,
  type WindowsDpapiWorkerDiagnostic,
  type WindowsDpapiWorkerPhase,
} from './windows-dpapi-worker.js';

const PROFILE_ID_PATTERN = /^byok-[a-z0-9][a-z0-9._-]{2,95}$/u;
const KEYCHAIN_SERVICE = 'dev.opendesign.byok';
const MAX_SECRET_OUTPUT_BYTES = 64 * 1024;
const MAX_BYOK_API_KEY_BYTES = 32 * 1024;
const INTERACTIVE_SECRET_TIMEOUT_MS = 10_000;

type StoredProfile = Omit<ByokCredentialProfile, 'configured' | 'keyTail'>;
type StoredDocument = {
  version: 1;
  profiles: StoredProfile[];
};

export interface ByokSecretBackend {
  readonly kind: string;
  available(): Promise<boolean>;
  close?(): Promise<void>;
  set(profileId: string, secret: string): Promise<void>;
  get(profileId: string): Promise<string | null>;
  delete(profileId: string): Promise<boolean>;
}

export interface ResolvedByokCredentialProfile {
  profile: ByokCredentialProfile;
  provider: ByokChatProviderConfig;
  apiKey: string;
}

export interface ByokCredentialServiceOptions {
  backend?: ByokSecretBackend;
  dataDir: string;
  persistMetadata?: (
    metadataPath: string,
    document: { version: 1; profiles: readonly unknown[] },
  ) => Promise<void>;
}

export class ByokCredentialService {
  readonly backend: ByokSecretBackend;
  readonly metadataPath: string;
  private mutationQueue: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;
  private closed = false;
  private readonly persistMetadata: NonNullable<
    ByokCredentialServiceOptions['persistMetadata']
  >;

  constructor(options: ByokCredentialServiceOptions) {
    this.backend = options.backend ?? createPlatformByokSecretBackend(
      process.platform,
      options.dataDir,
    );
    this.metadataPath = path.join(options.dataDir, 'byok', 'profiles.json');
    this.persistMetadata = options.persistMetadata ?? writeMetadataDocument;
  }

  async status(): Promise<{ available: boolean; backend: string }> {
    this.assertOpen();
    return {
      available: await this.backend.available(),
      backend: this.backend.kind,
    };
  }

  async list(): Promise<ByokCredentialProfile[]> {
    this.assertOpen();
    const document = await this.readDocument();
    return Promise.all(document.profiles.map((profile) => this.toPublicProfile(profile)));
  }

  async get(profileId: string): Promise<ByokCredentialProfile | null> {
    this.assertOpen();
    assertProfileId(profileId);
    const stored = (await this.readDocument()).profiles.find((profile) => profile.id === profileId);
    return stored ? this.toPublicProfile(stored) : null;
  }

  /**
   * Checks profile metadata without reading the OS credential store. Run
   * admission uses this so the secret is not materialized until the runtime is
   * actually being started.
   */
  async has(profileId: string): Promise<boolean> {
    this.assertOpen();
    assertProfileId(profileId);
    return (await this.readDocument()).profiles.some((profile) => profile.id === profileId);
  }

  async upsert(input: UpsertByokCredentialProfileRequest): Promise<ByokCredentialProfile> {
    this.assertOpen();
    return this.serializeMutation(() => this.upsertUnlocked(input));
  }

  private async upsertUnlocked(
    input: UpsertByokCredentialProfileRequest,
  ): Promise<ByokCredentialProfile> {
    const normalized = normalizeProfileInput(input);
    const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    if (Buffer.byteLength(apiKey, 'utf8') > MAX_BYOK_API_KEY_BYTES) {
      throw new Error(`apiKey must be at most ${MAX_BYOK_API_KEY_BYTES} UTF-8 bytes.`);
    }
    const available = await this.backend.available();
    if (!available) {
      throw new Error('Secure credential storage is unavailable on this system.');
    }
    const document = await this.readDocument();
    const existingIndex = input.id
      ? document.profiles.findIndex((profile) => profile.id === input.id)
      : -1;
    const now = Date.now();
    const id = input.id ?? createProfileId();
    assertProfileId(id);
    const existing = existingIndex >= 0 ? document.profiles[existingIndex] : undefined;
    if (normalized.requiresApiKey && !apiKey && !existing) {
      throw new Error('An API key is required when creating this BYOK profile.');
    }
    const previousSecret = apiKey ? await this.backend.get(id) : null;
    if (apiKey) {
      await this.backend.set(id, apiKey);
    } else if (normalized.requiresApiKey && !(await this.backend.get(id))) {
      throw new Error('The BYOK profile has no credential in secure storage.');
    }
    const stored: StoredProfile = {
      id,
      ...normalized,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existingIndex >= 0) document.profiles[existingIndex] = stored;
    else document.profiles.push(stored);
    try {
      await this.writeDocument(document);
    } catch (error) {
      if (apiKey) {
        await this.restoreSecretAfterMetadataFailure(
          id,
          previousSecret,
          error,
        );
      }
      throw error;
    }
    return this.toPublicProfile(stored);
  }

  async resolve(profileId: string): Promise<ResolvedByokCredentialProfile | null> {
    this.assertOpen();
    assertProfileId(profileId);
    const stored = (await this.readDocument()).profiles.find((profile) => profile.id === profileId);
    if (!stored) return null;
    const apiKey = stored.requiresApiKey ? (await this.backend.get(profileId))?.trim() ?? '' : '';
    if (stored.requiresApiKey && !apiKey) return null;
    const profile = await this.toPublicProfile(stored, apiKey);
    return {
      profile,
      apiKey,
      provider: {
        protocol: stored.protocol,
        apiKey,
        baseUrl: stored.baseUrl,
        model: stored.model,
        requiresApiKey: stored.requiresApiKey,
        ...(stored.apiVersion ? { apiVersion: stored.apiVersion } : {}),
      },
    };
  }

  async delete(profileId: string): Promise<boolean> {
    this.assertOpen();
    return this.serializeMutation(() => this.deleteUnlocked(profileId));
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeUnlocked();
    return this.closePromise;
  }

  private async closeUnlocked(): Promise<void> {
    this.closed = true;
    await this.mutationQueue;
    await this.backend.close?.();
  }

  private async deleteUnlocked(profileId: string): Promise<boolean> {
    assertProfileId(profileId);
    const document = await this.readDocument();
    const next = document.profiles.filter((profile) => profile.id !== profileId);
    const existed = next.length !== document.profiles.length;
    const previousSecret = await this.backend.get(profileId);
    const secretDeleted = await this.backend.delete(profileId);
    if (existed) {
      document.profiles = next;
      try {
        await this.writeDocument(document);
      } catch (error) {
        if (secretDeleted && previousSecret !== null) {
          await this.restoreSecretAfterMetadataFailure(
            profileId,
            previousSecret,
            error,
          );
        }
        throw error;
      }
    }
    return existed || secretDeleted;
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('Secure credential service is closed.');
    }
  }

  private async toPublicProfile(
    profile: StoredProfile,
    knownSecret?: string,
  ): Promise<ByokCredentialProfile> {
    const secret = profile.requiresApiKey
      ? knownSecret ?? await this.backend.get(profile.id) ?? ''
      : '';
    return {
      ...profile,
      configured: !profile.requiresApiKey || Boolean(secret),
      ...(secret ? { keyTail: secret.slice(-4) } : {}),
    };
  }

  private async readDocument(): Promise<StoredDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.metadataPath, 'utf8')) as Partial<StoredDocument>;
      if (parsed.version !== 1 || !Array.isArray(parsed.profiles)) {
        return { version: 1, profiles: [] };
      }
      return {
        version: 1,
        profiles: parsed.profiles.filter(isStoredProfile),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, profiles: [] };
      }
      throw error;
    }
  }

  private async writeDocument(document: StoredDocument): Promise<void> {
    await this.persistMetadata(this.metadataPath, document);
  }

  private async restoreSecretAfterMetadataFailure(
    profileId: string,
    previousSecret: string | null,
    metadataError: unknown,
  ): Promise<void> {
    try {
      if (previousSecret === null) {
        await this.backend.delete(profileId);
      } else {
        await this.backend.set(profileId, previousSecret);
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [metadataError, rollbackError],
        'BYOK metadata persistence failed and the secure credential rollback also failed.',
      );
    }
  }
}

async function writeMetadataDocument(
  metadataPath: string,
  document: { version: 1; profiles: readonly unknown[] },
): Promise<void> {
  await mkdir(path.dirname(metadataPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${metadataPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporaryPath, metadataPath);
}

function normalizeProfileInput(
  input: UpsertByokCredentialProfileRequest,
): Omit<StoredProfile, 'id' | 'createdAt' | 'updatedAt'> {
  const label = requiredBoundedString(input.label, 'label', 120);
  const baseUrl = requiredBoundedString(input.baseUrl, 'baseUrl', 2_048).replace(/\/+$/u, '');
  const model = requiredBoundedString(input.model, 'model', 256);
  const protocol = input.protocol;
  if (!['anthropic', 'openai', 'azure', 'google', 'ollama', 'senseaudio', 'aihubmix'].includes(protocol)) {
    throw new Error('Unsupported BYOK protocol.');
  }
  try {
    const parsed = new URL(baseUrl);
    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || parsed.username.length > 0
      || parsed.password.length > 0
      || parsed.search.length > 0
      || parsed.hash.length > 0
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(
      'BYOK baseUrl must be an absolute HTTP(S) URL without credentials, query, or fragment.',
    );
  }
  const apiVersion = typeof input.apiVersion === 'string' ? input.apiVersion.trim() : '';
  return {
    label,
    protocol,
    baseUrl,
    model,
    requiresApiKey: input.requiresApiKey !== false,
    ...(apiVersion ? { apiVersion: apiVersion.slice(0, 128) } : {}),
  };
}

function requiredBoundedString(value: unknown, field: string, max: number): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || trimmed.length > max) {
    throw new Error(`${field} is required and must be at most ${max} characters.`);
  }
  return trimmed;
}

function createProfileId(): string {
  return `byok-${randomUUID()}`;
}

function assertProfileId(profileId: string): void {
  if (!PROFILE_ID_PATTERN.test(profileId)) throw new Error('Invalid BYOK profile id.');
}

function isStoredProfile(value: unknown): value is StoredProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const profile = value as Partial<StoredProfile>;
  return typeof profile.id === 'string'
    && PROFILE_ID_PATTERN.test(profile.id)
    && typeof profile.label === 'string'
    && typeof profile.protocol === 'string'
    && typeof profile.baseUrl === 'string'
    && typeof profile.model === 'string'
    && typeof profile.requiresApiKey === 'boolean'
    && typeof profile.createdAt === 'number'
    && typeof profile.updatedAt === 'number';
}

export function createPlatformByokSecretBackend(
  platform: NodeJS.Platform = process.platform,
  dataDir?: string,
): ByokSecretBackend {
  if (platform === 'darwin') return new MacOsKeychainBackend();
  if (platform === 'linux') return new LinuxSecretServiceBackend();
  if (platform === 'win32' && dataDir) {
    return new WindowsDpapiBackend(path.join(dataDir, 'byok', 'secrets'));
  }
  return new UnavailableSecretBackend(platform);
}

class MacOsKeychainBackend implements ByokSecretBackend {
  readonly kind = 'macos-keychain';
  private writable: boolean | null = null;

  async available() {
    return this.writable !== false && await commandAvailable('/usr/bin/security');
  }

  async set(profileId: string, secret: string) {
    try {
      await runInteractiveMacOsSecretCommand(
        '/usr/bin/security',
        ['add-generic-password', '-a', profileId, '-s', KEYCHAIN_SERVICE, '-U', '-w'],
        secret,
      );
      this.writable = true;
    } catch (error) {
      this.writable = false;
      if (isNodePtyUnavailableError(error)) {
        throw new Error(
          'Secure credential storage is unavailable because its native PTY helper could not be loaded.',
          { cause: error },
        );
      }
      throw new Error('Secure credential backend command failed.');
    }
  }

  async get(profileId: string) {
    const result = await runSecretCommand(
      '/usr/bin/security',
      ['find-generic-password', '-a', profileId, '-s', KEYCHAIN_SERVICE, '-w'],
      undefined,
      true,
    );
    return result === null ? null : result.trimEnd();
  }

  async delete(profileId: string) {
    return (await runSecretCommand(
      '/usr/bin/security',
      ['delete-generic-password', '-a', profileId, '-s', KEYCHAIN_SERVICE],
      undefined,
      true,
    )) !== null;
  }
}

class LinuxSecretServiceBackend implements ByokSecretBackend {
  readonly kind = 'linux-secret-service';
  private readonly command = 'secret-tool';

  async available() {
    return commandAvailable(this.command);
  }

  async set(profileId: string, secret: string) {
    await runSecretCommand(
      this.command,
      ['store', '--label=Open Design BYOK', 'service', KEYCHAIN_SERVICE, 'account', profileId],
      secret,
    );
  }

  async get(profileId: string) {
    const result = await runSecretCommand(
      this.command,
      ['lookup', 'service', KEYCHAIN_SERVICE, 'account', profileId],
      undefined,
      true,
    );
    return result === null ? null : result.trimEnd();
  }

  async delete(profileId: string) {
    return (await runSecretCommand(
      this.command,
      ['clear', 'service', KEYCHAIN_SERVICE, 'account', profileId],
      undefined,
      true,
    )) !== null;
  }
}

type WindowsDpapiWorkerClient = Pick<WindowsDpapiWorker, 'close' | 'ready' | 'run'>;

type WindowsDpapiWorkerTimeouts = {
  connectMs: number;
  startupMs: number;
  readyMs: number;
  operationMs: number;
  shutdownMs: number;
};

type WindowsDpapiWorkerSlot = {
  abortController: AbortController;
  closePromise: Promise<void> | null;
  generation: number;
  promise: Promise<WindowsDpapiWorkerClient>;
  readyPromise: Promise<void> | null;
};

const DEFAULT_WINDOWS_DPAPI_WORKER_TIMEOUTS: WindowsDpapiWorkerTimeouts = {
  connectMs: 50_000,
  startupMs: 55_000,
  readyMs: 3_000,
  operationMs: 5_000,
  shutdownMs: 5_000,
};

export type WindowsDpapiBackendOptions = {
  commandAvailable?: (command: string) => Promise<boolean>;
  createWorker?: (options?: { signal: AbortSignal }) => Promise<WindowsDpapiWorkerClient>;
  onDiagnostic?: (diagnostic: WindowsDpapiWorkerDiagnostic) => void;
  timeouts?: Partial<WindowsDpapiWorkerTimeouts>;
};

export class WindowsDpapiBackend implements ByokSecretBackend {
  readonly kind = 'windows-dpapi';
  private availability: Promise<boolean> | null = null;
  private worker: WindowsDpapiWorkerSlot | null = null;
  private workerGeneration = 0;
  private closePromise: Promise<void> | null = null;
  private closed = false;
  private readonly timeouts: WindowsDpapiWorkerTimeouts;

  constructor(
    private readonly secretsDir: string,
    private readonly options: WindowsDpapiBackendOptions = {},
  ) {
    this.timeouts = {
      connectMs: positiveWindowsDpapiTimeout(
        options.timeouts?.connectMs,
        DEFAULT_WINDOWS_DPAPI_WORKER_TIMEOUTS.connectMs,
      ),
      startupMs: positiveWindowsDpapiTimeout(
        options.timeouts?.startupMs,
        DEFAULT_WINDOWS_DPAPI_WORKER_TIMEOUTS.startupMs,
      ),
      readyMs: positiveWindowsDpapiTimeout(
        options.timeouts?.readyMs,
        DEFAULT_WINDOWS_DPAPI_WORKER_TIMEOUTS.readyMs,
      ),
      operationMs: positiveWindowsDpapiTimeout(
        options.timeouts?.operationMs,
        DEFAULT_WINDOWS_DPAPI_WORKER_TIMEOUTS.operationMs,
      ),
      shutdownMs: positiveWindowsDpapiTimeout(
        options.timeouts?.shutdownMs,
        DEFAULT_WINDOWS_DPAPI_WORKER_TIMEOUTS.shutdownMs,
      ),
    };
  }

  async available() {
    if (this.closed) return false;
    this.availability ??= this.probeAvailability();
    const attempt = this.availability;
    try {
      const available = await attempt;
      if (!available && this.availability === attempt) {
        this.availability = null;
      }
      return available;
    } catch {
      if (this.availability === attempt) {
        this.availability = null;
      }
      return false;
    }
  }

  private async probeAvailability() {
    if (!(await (this.options.commandAvailable ?? commandAvailable)('powershell.exe'))) {
      return false;
    }
    try {
      await this.getReadyWorker();
      return true;
    } catch {
      return false;
    }
  }

  async set(profileId: string, secret: string) {
    assertProfileId(profileId);
    await this.runWorker(
      'set',
      path.join(this.secretsDir, `${profileId}.bin`),
      secret,
    );
  }

  async get(profileId: string) {
    assertProfileId(profileId);
    const result = await this.runWorker(
      'get',
      path.join(this.secretsDir, `${profileId}.bin`),
    );
    return result.found ? result.value : null;
  }

  async delete(profileId: string) {
    assertProfileId(profileId);
    return (await this.runWorker(
      'delete',
      path.join(this.secretsDir, `${profileId}.bin`),
    )).found;
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeUnlocked();
    return this.closePromise;
  }

  private async closeUnlocked(): Promise<void> {
    this.closed = true;
    this.availability = null;
    const slot = this.worker;
    this.worker = null;
    if (slot) await this.disposeWorker(slot);
  }

  private async runWorker(
    operation: 'set' | 'get' | 'delete',
    secretPath: string,
    secret?: string,
  ) {
    const { slot, worker } = await this.getReadyWorker();
    const startedAt = Date.now();
    try {
      return await withWindowsDpapiTimeout(
        worker.run(operation, secretPath, secret),
        this.timeouts.operationMs,
        'operation',
      );
    } catch (error) {
      throw await this.handleWorkerFailure(
        slot,
        error,
        'operation',
        startedAt,
        worker,
      );
    }
  }

  private async getReadyWorker(): Promise<{
    slot: WindowsDpapiWorkerSlot;
    worker: WindowsDpapiWorkerClient;
  }> {
    const slot = this.getWorkerSlot();
    const startupStartedAt = Date.now();
    let worker: WindowsDpapiWorkerClient;
    try {
      worker = await withWindowsDpapiTimeout(
        slot.promise,
        this.timeouts.startupMs,
        'spawn',
      );
    } catch (error) {
      throw await this.handleWorkerFailure(slot, error, 'spawn', startupStartedAt);
    }
    const readyStartedAt = Date.now();
    try {
      slot.readyPromise ??= worker.ready();
      await withWindowsDpapiTimeout(
        slot.readyPromise,
        this.timeouts.readyMs,
        'ready',
      );
    } catch (error) {
      throw await this.handleWorkerFailure(
        slot,
        error,
        'ready',
        readyStartedAt,
        worker,
      );
    }
    return { slot, worker };
  }

  private getWorkerSlot(): WindowsDpapiWorkerSlot {
    if (this.closed) {
      throw new WindowsDpapiWorkerError('operation', 'closed', false);
    }
    if (this.worker) return this.worker;
    const generation = ++this.workerGeneration;
    const abortController = new AbortController();
    const promise = Promise.resolve().then(
      () => this.options.createWorker?.({
        signal: abortController.signal,
      }) ?? WindowsDpapiWorker.create({
        connectTimeoutMs: this.timeouts.connectMs,
        signal: abortController.signal,
        shutdownTimeoutMs: this.timeouts.shutdownMs,
      }),
    );
    const slot: WindowsDpapiWorkerSlot = {
      abortController,
      closePromise: null,
      generation,
      promise,
      readyPromise: null,
    };
    this.worker = slot;
    return slot;
  }

  private async handleWorkerFailure(
    slot: WindowsDpapiWorkerSlot,
    error: unknown,
    fallbackPhase: WindowsDpapiWorkerPhase,
    startedAt: number,
    worker?: WindowsDpapiWorkerClient,
  ): Promise<WindowsDpapiWorkerError> {
    const safeError = normalizeWindowsDpapiError(error, fallbackPhase);
    if (this.closed && safeError.failureClass === 'closed') {
      return safeError;
    }
    this.reportDiagnostic({
      phase: safeError.phase,
      failureClass: safeError.failureClass,
      durationMs: Math.max(0, Date.now() - startedAt),
      workerGeneration: slot.generation,
    });
    if (safeError.fatal) {
      if (this.worker === slot) {
        this.worker = null;
        this.availability = null;
      }
      try {
        await this.disposeWorker(slot, worker);
      } catch {
        // Preserve the operation failure; disposeWorker already emitted the
        // separate safe shutdown diagnostic.
      }
    }
    return safeError;
  }

  private async disposeWorker(
    slot: WindowsDpapiWorkerSlot,
    knownWorker?: WindowsDpapiWorkerClient,
  ): Promise<void> {
    slot.closePromise ??= this.disposeWorkerUnlocked(slot, knownWorker);
    await slot.closePromise;
  }

  private async disposeWorkerUnlocked(
    slot: WindowsDpapiWorkerSlot,
    knownWorker?: WindowsDpapiWorkerClient,
  ): Promise<void> {
    slot.abortController.abort();
    let worker = knownWorker;
    if (!worker) {
      try {
        worker = await withWindowsDpapiTimeout(
          slot.promise,
          this.timeouts.shutdownMs,
          'shutdown',
        );
      } catch (error) {
        const safeError = normalizeWindowsDpapiError(error, 'shutdown');
        if (safeError.failureClass === 'closed') return;
        void slot.promise.then(
          (lateWorker) => withWindowsDpapiTimeout(
            lateWorker.close(),
            this.timeouts.shutdownMs,
            'shutdown',
          ).catch(() => undefined),
          () => undefined,
        );
        if (safeError.failureClass === 'timeout') {
          this.reportDiagnostic({
            phase: 'shutdown',
            failureClass: 'timeout',
            durationMs: this.timeouts.shutdownMs,
            workerGeneration: slot.generation,
          });
          throw safeError;
        }
        return;
      }
    }
    const startedAt = Date.now();
    try {
      await withWindowsDpapiTimeout(
        worker.close(),
        this.timeouts.shutdownMs,
        'shutdown',
      );
    } catch (error) {
      const safeError = normalizeWindowsDpapiError(error, 'shutdown');
      this.reportDiagnostic({
        phase: safeError.phase,
        failureClass: safeError.failureClass,
        durationMs: Math.max(0, Date.now() - startedAt),
        workerGeneration: slot.generation,
      });
      throw safeError;
    }
  }

  private reportDiagnostic(diagnostic: WindowsDpapiWorkerDiagnostic): void {
    try {
      if (this.options.onDiagnostic) {
        this.options.onDiagnostic(diagnostic);
      } else {
        console.warn('[byok] Windows DPAPI worker failure', diagnostic);
      }
    } catch {
      // Observability must never change credential storage behavior.
    }
  }
}

function withWindowsDpapiTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  phase: WindowsDpapiWorkerPhase,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new WindowsDpapiWorkerError(phase, 'timeout'));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function positiveWindowsDpapiTimeout(
  value: number | undefined,
  fallback: number,
): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

function normalizeWindowsDpapiError(
  error: unknown,
  phase: WindowsDpapiWorkerPhase,
): WindowsDpapiWorkerError {
  return error instanceof WindowsDpapiWorkerError
    ? error
    : new WindowsDpapiWorkerError(phase, 'unknown');
}

class UnavailableSecretBackend implements ByokSecretBackend {
  readonly kind: string;

  constructor(platform: NodeJS.Platform) {
    this.kind = `unavailable-${platform}`;
  }

  async available() { return false; }
  async set() { throw new Error('Secure credential storage is unavailable on this system.'); }
  async get() { return null; }
  async delete() { return false; }
}

async function commandAvailable(command: string): Promise<boolean> {
  if (path.isAbsolute(command)) {
    try {
      await access(command);
      return true;
    } catch {
      return false;
    }
  }
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter);
  return Promise.any(pathEntries.map(async (entry) => {
    const candidate = path.join(entry, command);
    await access(candidate);
    return true;
  })).catch(() => false);
}

async function runSecretCommand(
  command: string,
  args: string[],
  secretInput?: string,
  allowNotFound = false,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_SECRET_OUTPUT_BYTES) stdout.push(chunk);
    });
    child.stderr.resume();
    child.on('error', () => reject(new Error('Secure credential backend command failed.')));
    child.on('close', (code) => {
      if (code === 0) return resolve(Buffer.concat(stdout).toString('utf8'));
      if (allowNotFound && code === 44) return resolve(null);
      if (allowNotFound && code === 1) return resolve(null);
      return reject(new Error('Secure credential backend command failed.'));
    });
    if (secretInput !== undefined) child.stdin.end(`${secretInput}\n`);
    else child.stdin.end();
  });
}

/**
 * `security add-generic-password -w` intentionally prompts twice when the
 * password argument is omitted. A regular stdin pipe is not accepted by the
 * macOS tool, while putting the key after `-w` exposes it in the process list.
 * Drive only those bounded prompts through a pseudo-terminal and keep all
 * output private.
 */
async function runInteractiveMacOsSecretCommand(
  command: string,
  args: string[],
  secret: string,
): Promise<void> {
  const { spawn: spawnPty } = await loadNodePty();
  return new Promise((resolve, reject) => {
    let settled = false;
    let promptResponses = 0;
    let promptScan = '';
    let dataDisposable: { dispose(): void } | null = null;
    let exitDisposable: { dispose(): void } | null = null;
    // `security` does not reliably disable terminal echo before its password
    // prompts. Use a fixed shell program (no interpolation) to disable echo,
    // then exec the command and its validated argv verbatim.
    const child = spawnPty('/bin/sh', [
      '-c',
      'stty -echo; exec "$@"',
      'open-design-keychain',
      command,
      ...args,
    ], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: { ...process.env },
    });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      dataDisposable?.dispose();
      exitDisposable?.dispose();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Best-effort termination; the generic failure below stays secret-free.
      }
      finish(new Error('Secure credential backend command failed.'));
    }, INTERACTIVE_SECRET_TIMEOUT_MS);
    timer.unref?.();
    dataDisposable = child.onData((chunk) => {
      // Security prompts should disable terminal echo. Redact defensively
      // before retaining the bounded prompt tail anyway.
      const safeChunk = secret
        ? chunk.split(secret).join('[redacted]')
        : chunk;
      promptScan = `${promptScan}${safeChunk}`.slice(-512);
      const promptCount = (
        promptScan.match(/(?:retype[^\r\n:]*|password[^\r\n:]*)\s*:/giu)
        ?? []
      ).length;
      while (promptResponses < Math.min(promptCount, 2)) {
        child.write(`${secret}\r`);
        promptResponses += 1;
      }
    });
    exitDisposable = child.onExit(({ exitCode }) => {
      finish(
        exitCode === 0
          ? undefined
          : new Error('Secure credential backend command failed.'),
      );
    });
  });
}
