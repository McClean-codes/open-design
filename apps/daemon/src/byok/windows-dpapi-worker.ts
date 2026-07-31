import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Server, Socket } from 'node:net';
import { createServer } from 'node:net';

const MAX_WORKER_LINE_BYTES = 64 * 1024;
const MAX_AUTHENTICATING_CONNECTIONS = 16;
const PIPE_AUTH_CHALLENGE_BYTES = 32;
const PIPE_AUTH_KEY_BYTES = 32;
const PIPE_AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 50_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

// Keep one PowerShell process alive for the daemon lifetime. Packaged Windows
// can spend tens of seconds scanning each new encoded PowerShell command, so a
// process per probe/set/get/delete makes a single BYOK request exceed its IPC
// timeout even though the DPAPI calls themselves finish in milliseconds.
export type WindowsDpapiWorkerOperation = 'set' | 'get' | 'delete';

export type WindowsDpapiWorkerResult = {
  found: boolean;
  value: string | null;
};

export type WindowsDpapiWorkerPhase =
  | 'spawn'
  | 'connect'
  | 'ready'
  | 'operation'
  | 'shutdown';

export type WindowsDpapiWorkerFailureClass =
  | 'timeout'
  | 'spawn'
  | 'child-exit'
  | 'pipe-close'
  | 'protocol'
  | 'input'
  | 'dpapi'
  | 'closed'
  | 'unknown';

export type WindowsDpapiWorkerDiagnostic = {
  phase: WindowsDpapiWorkerPhase;
  failureClass: WindowsDpapiWorkerFailureClass;
  durationMs: number;
  workerGeneration: number;
};

export class WindowsDpapiWorkerError extends Error {
  readonly name = 'WindowsDpapiWorkerError';

  constructor(
    readonly phase: WindowsDpapiWorkerPhase,
    readonly failureClass: WindowsDpapiWorkerFailureClass,
    readonly fatal = true,
  ) {
    super('Secure credential backend command failed.');
  }
}

type WindowsDpapiWorkerRequest = {
  id: string;
  operation: WindowsDpapiWorkerOperation;
  path: string;
  secret?: string;
};

type WindowsDpapiWorkerResponse = {
  found?: boolean;
  id?: string;
  ok?: boolean;
  proof?: string;
  type?: string;
  value?: string;
};

type SpawnWindowsDpapiWorker = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & {
    stdio: ['pipe', 'pipe', 'pipe'];
  },
) => ChildProcessWithoutNullStreams;

type WindowsDpapiPipeAddress = {
  connectionName: string;
  listenPath: string;
};

export type WindowsDpapiWorkerCreateOptions = {
  connectTimeoutMs?: number;
  pipeAddress?: WindowsDpapiPipeAddress;
  signal?: AbortSignal;
  shutdownTimeoutMs?: number;
  spawnWorker?: SpawnWindowsDpapiWorker;
};

type WindowsDpapiWorkerTransportOptions = {
  shutdownTimeoutMs?: number;
};

const WINDOWS_DPAPI_WORKER_SCRIPT = `
$ErrorActionPreference = 'Stop'
function Write-OpenDesignDpapiResponse([hashtable]$response) {
  $writer.WriteLine(($response | ConvertTo-Json -Compress))
}

$pipe = New-Object System.IO.Pipes.NamedPipeClientStream(
  '.',
  $env:OD_BYOK_DPAPI_PIPE_NAME,
  [System.IO.Pipes.PipeDirection]::InOut,
  [System.IO.Pipes.PipeOptions]::None
)
$pipe.Connect()
$parentProcess = [System.Diagnostics.Process]::GetProcessById(
  [int]$env:OD_BYOK_DPAPI_PARENT_PID
)
$reader = New-Object System.IO.StreamReader(
  $pipe,
  [System.Text.Encoding]::UTF8,
  $false,
  1024,
  $true
)
$writer = New-Object System.IO.StreamWriter(
  $pipe,
  (New-Object System.Text.UTF8Encoding($false)),
  1024,
  $true
)
$writer.AutoFlush = $true

try {
  $authenticationKey = [System.Convert]::FromBase64String(
    [Console]::In.ReadLine()
  )
  if ($authenticationKey.Length -ne 32) {
    throw 'Invalid pipe authentication key'
  }
  $challengeEnvelope = $reader.ReadLine() | ConvertFrom-Json
  if ([string]$challengeEnvelope.type -ne 'challenge') {
    throw 'Invalid pipe authentication challenge'
  }
  $challenge = [System.Convert]::FromBase64String(
    [string]$challengeEnvelope.challenge
  )
  if ($challenge.Length -ne 32) {
    throw 'Invalid pipe authentication challenge'
  }
  $hmac = [System.Security.Cryptography.HMACSHA256]::new($authenticationKey)
  try {
    $proof = $hmac.ComputeHash($challenge)
  } finally {
    $hmac.Dispose()
  }
  Write-OpenDesignDpapiResponse @{
    type = 'authenticate'
    proof = [System.Convert]::ToBase64String($proof)
  }
} catch {
  exit 1
} finally {
  if ($authenticationKey -ne $null) {
    [System.Array]::Clear($authenticationKey, 0, $authenticationKey.Length)
  }
}

try {
  [void][System.Reflection.Assembly]::LoadFrom(
    [System.IO.Path]::Combine(
      [System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory(),
      'System.Security.dll'
    )
  )
  $probePlain = [System.Text.Encoding]::UTF8.GetBytes('open-design-dpapi-probe')
  $probeCipher = [System.Security.Cryptography.ProtectedData]::Protect(
    $probePlain,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  $probeRoundTrip = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $probeCipher,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  if ([System.Text.Encoding]::UTF8.GetString($probeRoundTrip) -ne 'open-design-dpapi-probe') {
    throw 'DPAPI probe failed'
  }
  Write-OpenDesignDpapiResponse @{ type = 'ready'; ok = $true }
} catch {
  Write-OpenDesignDpapiResponse @{ type = 'ready'; ok = $false }
  exit 1
}

while ($true) {
  $readTask = $reader.ReadLineAsync()
  while (-not $readTask.Wait(500)) {
    if ($parentProcess.HasExited) {
      exit 0
    }
  }
  $line = $readTask.Result
  if ($line -eq $null) {
    break
  }
  if ($parentProcess.HasExited) {
    exit 0
  }
  $requestId = ''
  try {
    $request = $line | ConvertFrom-Json
    $requestId = [string]$request.id
    $operation = [string]$request.operation
    $secretPath = [System.Text.Encoding]::UTF8.GetString(
      [System.Convert]::FromBase64String([string]$request.path)
    )

    if ($operation -eq 'set') {
      $secret = [System.Text.Encoding]::UTF8.GetString(
        [System.Convert]::FromBase64String([string]$request.secret)
      )
      if ([string]::IsNullOrWhiteSpace($secret)) {
        throw 'Secret must not be empty'
      }
      $plain = [System.Text.Encoding]::UTF8.GetBytes($secret)
      $cipher = [System.Security.Cryptography.ProtectedData]::Protect(
        $plain,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
      )
      $directory = [System.IO.Path]::GetDirectoryName($secretPath)
      [System.IO.Directory]::CreateDirectory($directory) | Out-Null
      $temporaryPath = "$secretPath.$([Guid]::NewGuid().ToString('N')).tmp"
      try {
        [System.IO.File]::WriteAllBytes($temporaryPath, $cipher)
        Move-Item -LiteralPath $temporaryPath -Destination $secretPath -Force
      } finally {
        if (Test-Path -LiteralPath $temporaryPath) {
          Remove-Item -LiteralPath $temporaryPath -Force
        }
      }
      Write-OpenDesignDpapiResponse @{ id = $requestId; ok = $true; found = $true }
      continue
    }

    if ($operation -eq 'get') {
      if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
        Write-OpenDesignDpapiResponse @{ id = $requestId; ok = $true; found = $false }
        continue
      }
      $cipher = [System.IO.File]::ReadAllBytes($secretPath)
      $plain = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $cipher,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
      )
      Write-OpenDesignDpapiResponse @{
        id = $requestId
        ok = $true
        found = $true
        value = [System.Convert]::ToBase64String($plain)
      }
      continue
    }

    if ($operation -eq 'delete') {
      if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
        Write-OpenDesignDpapiResponse @{ id = $requestId; ok = $true; found = $false }
        continue
      }
      Remove-Item -LiteralPath $secretPath -Force
      Write-OpenDesignDpapiResponse @{ id = $requestId; ok = $true; found = $true }
      continue
    }

    throw 'Unsupported DPAPI operation'
  } catch {
    Write-OpenDesignDpapiResponse @{ id = $requestId; ok = $false }
  }
}
`;

const WINDOWS_DPAPI_WORKER_ENCODED_SCRIPT = Buffer.from(
  WINDOWS_DPAPI_WORKER_SCRIPT,
  'utf16le',
).toString('base64');

export class WindowsDpapiWorker {
  private readonly readyPromise: Promise<void>;
  private readonly childExitPromise: Promise<void>;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private inputBuffer = '';
  private nextRequestId = 0;
  private operationQueue: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;
  private pending: {
    id: string;
    reject(error: Error): void;
    resolve(response: WindowsDpapiWorkerResponse): void;
  } | null = null;
  private closed = false;
  private closing = false;
  private childExited = false;
  private readonly shutdownTimeoutMs: number;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly pipe: Socket,
    options: WindowsDpapiWorkerTransportOptions = {},
  ) {
    this.shutdownTimeoutMs = positiveTimeout(
      options.shutdownTimeoutMs,
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
    );
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.readyPromise.catch(() => undefined);
    this.childExitPromise = new Promise<void>((resolve) => {
      const markExited = () => {
        this.childExited = true;
        resolve();
      };
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        markExited();
      } else {
        this.child.once('close', markExited);
      }
    });
    this.pipe.on('data', (chunk: Buffer) => this.acceptInput(chunk));
    this.pipe.on('error', () => {
      if (!this.closing) this.fail('pipe-close');
    });
    this.pipe.on('close', () => {
      if (!this.closing) this.fail('pipe-close');
    });
    this.pipe.resume();
    this.child.stdout.resume();
    this.child.stderr.resume();
    this.child.on('error', () => {
      if (!this.closing) this.fail('child-exit');
    });
    this.child.on('close', () => {
      if (!this.closing) this.fail('child-exit');
    });
  }

  static async create(
    options: WindowsDpapiWorkerCreateOptions = {},
  ): Promise<WindowsDpapiWorker> {
    if (options.signal?.aborted) {
      throw secureCredentialCommandError('shutdown', 'closed', false);
    }
    const pipeAddress = options.pipeAddress ?? createWindowsPipeAddress();
    const server = createServer();
    try {
      await listen(server, pipeAddress.listenPath);
    } catch {
      await closeServer(server);
      throw secureCredentialCommandError('spawn', 'spawn');
    }
    if (options.signal?.aborted) {
      await closeServer(server);
      throw secureCredentialCommandError('shutdown', 'closed', false);
    }
    const authenticationKey = randomBytes(PIPE_AUTH_KEY_BYTES);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (options.spawnWorker ?? spawn)(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          WINDOWS_DPAPI_WORKER_ENCODED_SCRIPT,
        ],
        {
          env: {
            ...process.env,
            OD_BYOK_DPAPI_PARENT_PID: String(process.pid),
            OD_BYOK_DPAPI_PIPE_NAME: pipeAddress.connectionName,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
    } catch {
      authenticationKey.fill(0);
      await closeServer(server);
      throw secureCredentialCommandError('spawn', 'spawn');
    }
    // The packaged process must not retain an open stdin stream. Only this
    // per-generation pipe-authentication capability crosses stdin; BYOK
    // credentials stay out of argv, environment variables, and temporary
    // files and are sent only after the child proves possession of the key.
    child.stdin.end(`${authenticationKey.toString('base64')}\n`);
    const connectionAbortController = new AbortController();
    const connection = waitForAuthenticatedConnection(
      server,
      authenticationKey,
      connectionAbortController.signal,
    );
    try {
      const pipe = await withTimeout(
        Promise.race([
          connection,
          childFailure(child),
          abortFailure(options.signal),
        ]),
        positiveTimeout(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS),
        'connect',
      );
      authenticationKey.fill(0);
      server.close();
      return new WindowsDpapiWorker(child, pipe, options);
    } catch (error) {
      authenticationKey.fill(0);
      connectionAbortController.abort();
      void connection.then(
        (latePipe) => latePipe.destroy(),
        () => undefined,
      );
      if (
        !child.killed
        && child.exitCode === null
        && child.signalCode === null
      ) {
        try {
          child.kill();
        } catch {
          // The safe error below is the only detail that leaves this boundary.
        }
      }
      await closeServer(server);
      throw normalizeWorkerError(error, 'connect');
    }
  }

  /**
   * Build a worker from an already-connected transport. The production create
   * path and protocol tests share this boundary so lifecycle behavior is not
   * reimplemented in a test-only fake.
   */
  static fromConnectedTransport(
    child: ChildProcessWithoutNullStreams,
    pipe: Socket,
    options: WindowsDpapiWorkerTransportOptions = {},
  ): WindowsDpapiWorker {
    return new WindowsDpapiWorker(child, pipe, options);
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  get processId(): number | undefined {
    return this.child.pid;
  }

  run(
    operation: WindowsDpapiWorkerOperation,
    secretPath: string,
    secret?: string,
  ): Promise<WindowsDpapiWorkerResult> {
    const result = this.operationQueue.then(
      () => this.runUnlocked(operation, secretPath, secret),
      () => this.runUnlocked(operation, secretPath, secret),
    );
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async runUnlocked(
    operation: WindowsDpapiWorkerOperation,
    secretPath: string,
    secret?: string,
  ): Promise<WindowsDpapiWorkerResult> {
    await this.readyPromise;
    if (this.closed || this.closing || this.pending) {
      throw secureCredentialCommandError('operation', 'closed');
    }
    const id = String(++this.nextRequestId);
    const request: WindowsDpapiWorkerRequest = {
      id,
      operation,
      path: Buffer.from(secretPath, 'utf8').toString('base64'),
      ...(secret === undefined
        ? {}
        : { secret: Buffer.from(secret, 'utf8').toString('base64') }),
    };
    const encodedRequest = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(encodedRequest, 'utf8') > MAX_WORKER_LINE_BYTES) {
      throw secureCredentialCommandError('operation', 'input', false);
    }
    const response = await new Promise<WindowsDpapiWorkerResponse>((resolve, reject) => {
      this.pending = { id, reject, resolve };
      this.pipe.write(encodedRequest, 'utf8', (error) => {
        if (error) this.fail('pipe-close');
      });
    });
    if (response.id !== id) {
      this.fail('protocol');
      throw secureCredentialCommandError('operation', 'protocol');
    }
    if (response.ok !== true) {
      throw secureCredentialCommandError('operation', 'dpapi', false);
    }
    if (operation === 'get' && response.found === true) {
      if (typeof response.value !== 'string') {
        this.fail('protocol');
        throw secureCredentialCommandError('operation', 'protocol');
      }
      const value = decodeCanonicalBase64(response.value);
      if (value === null || value.byteLength > MAX_WORKER_LINE_BYTES) {
        this.fail('protocol');
        throw secureCredentialCommandError('operation', 'protocol');
      }
      return { found: true, value: value.toString('utf8') };
    }
    return {
      found: response.found === true,
      value: null,
    };
  }

  private acceptInput(chunk: Buffer): void {
    if (this.closed) return;
    this.inputBuffer += chunk.toString('utf8');
    if (Buffer.byteLength(this.inputBuffer, 'utf8') > MAX_WORKER_LINE_BYTES) {
      this.fail('protocol');
      return;
    }
    let newlineIndex = this.inputBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.inputBuffer.slice(0, newlineIndex).trim();
      this.inputBuffer = this.inputBuffer.slice(newlineIndex + 1);
      if (line) this.acceptLine(line);
      if (this.closed) return;
      newlineIndex = this.inputBuffer.indexOf('\n');
    }
  }

  private acceptLine(line: string): void {
    let response: WindowsDpapiWorkerResponse;
    try {
      response = JSON.parse(line) as WindowsDpapiWorkerResponse;
    } catch {
      this.fail('protocol');
      return;
    }
    if (response.type === 'ready') {
      if (response.ok === true && this.resolveReady) {
        this.resolveReady();
        this.resolveReady = null;
        this.rejectReady = null;
        return;
      }
      this.fail(response.ok === false ? 'dpapi' : 'protocol');
      return;
    }
    if (!this.pending || response.id !== this.pending.id) {
      this.fail('protocol');
      return;
    }
    const pending = this.pending;
    this.pending = null;
    pending.resolve(response);
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeUnlocked();
    return this.closePromise;
  }

  private async closeUnlocked(): Promise<void> {
    if (this.closed && this.childExited) return;
    this.closing = true;
    this.closed = true;
    const closedError = secureCredentialCommandError('shutdown', 'closed');
    this.rejectReady?.(closedError);
    this.resolveReady = null;
    this.rejectReady = null;
    this.pending?.reject(closedError);
    this.pending = null;
    if (!this.pipe.destroyed) {
      this.pipe.end();
    }
    const shutdownMarginMs = Math.min(
      250,
      Math.max(1, Math.floor(this.shutdownTimeoutMs / 10)),
    );
    const ownedShutdownBudgetMs = Math.max(0, this.shutdownTimeoutMs - shutdownMarginMs);
    const gracefulShutdownBudgetMs = Math.floor(ownedShutdownBudgetMs / 2);
    const forcedShutdownBudgetMs = ownedShutdownBudgetMs - gracefulShutdownBudgetMs;
    if (await settlesBefore(this.childExitPromise, gracefulShutdownBudgetMs)) {
      this.pipe.destroy();
      this.destroyStreams();
      return;
    }
    if (!this.childExited && !this.child.killed) {
      try {
        this.child.kill();
      } catch {
        // Report a safe shutdown timeout after the bounded final wait.
      }
    }
    if (!(await settlesBefore(this.childExitPromise, forcedShutdownBudgetMs))) {
      this.pipe.destroy();
      this.destroyStreams();
      throw secureCredentialCommandError('shutdown', 'timeout');
    }
    this.pipe.destroy();
    this.destroyStreams();
  }

  private fail(failureClass: WindowsDpapiWorkerFailureClass): void {
    if (this.closed) return;
    this.closed = true;
    const phase = this.resolveReady ? 'ready' : 'operation';
    const error = secureCredentialCommandError(phase, failureClass);
    this.rejectReady?.(error);
    this.resolveReady = null;
    this.rejectReady = null;
    this.pending?.reject(error);
    this.pending = null;
    this.pipe.destroy();
    if (!this.childExited && !this.child.killed) {
      try {
        this.child.kill();
      } catch {
        // The worker is already terminal; preserve only the safe failure.
      }
    }
  }

  private destroyStreams(): void {
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      try {
        stream.destroy();
      } catch {
        // Best-effort file-descriptor cleanup after the child is terminal.
      }
    }
  }
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(path, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function waitForAuthenticatedConnection(
  server: Server,
  authenticationKey: Buffer,
  signal: AbortSignal,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const authenticating = new Set<Socket>();
    const cleanup = () => {
      server.off('connection', onConnection);
      server.off('error', onServerError);
      signal.removeEventListener('abort', onAbort);
    };
    const rejectOnce = (error: WindowsDpapiWorkerError) => {
      if (settled) return;
      settled = true;
      cleanup();
      for (const pipe of authenticating) pipe.destroy();
      authenticating.clear();
      reject(error);
    };
    const onServerError = () => {
      rejectOnce(secureCredentialCommandError('connect', 'pipe-close'));
    };
    const onAbort = () => {
      rejectOnce(secureCredentialCommandError('shutdown', 'closed', false));
    };
    const onConnection = (pipe: Socket) => {
      if (settled || authenticating.size >= MAX_AUTHENTICATING_CONNECTIONS) {
        pipe.destroy();
        return;
      }
      authenticating.add(pipe);
      void authenticatePipeClient(pipe, authenticationKey).then((authenticated) => {
        authenticating.delete(pipe);
        if (settled) {
          pipe.destroy();
          return;
        }
        if (!authenticated) {
          pipe.destroy();
          return;
        }
        settled = true;
        cleanup();
        for (const otherPipe of authenticating) otherPipe.destroy();
        authenticating.clear();
        resolve(pipe);
      });
    };
    server.on('connection', onConnection);
    server.once('error', onServerError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function authenticatePipeClient(
  pipe: Socket,
  authenticationKey: Buffer,
): Promise<boolean> {
  return new Promise((resolve) => {
    const challenge = randomBytes(PIPE_AUTH_CHALLENGE_BYTES);
    const expectedProof = createHmac('sha256', authenticationKey)
      .update(challenge)
      .digest();
    let inputBuffer = '';
    let settled = false;
    const finish = (authenticated: boolean, remainder = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      pipe.off('data', onData);
      if (authenticated) {
        pipe.pause();
        if (remainder) pipe.unshift(Buffer.from(remainder, 'utf8'));
      }
      challenge.fill(0);
      expectedProof.fill(0);
      resolve(authenticated);
    };
    const onData = (chunk: Buffer) => {
      inputBuffer += chunk.toString('utf8');
      if (Buffer.byteLength(inputBuffer, 'utf8') > MAX_WORKER_LINE_BYTES) {
        finish(false);
        return;
      }
      const newlineIndex = inputBuffer.indexOf('\n');
      if (newlineIndex < 0) return;
      const line = inputBuffer.slice(0, newlineIndex).trim();
      const remainder = inputBuffer.slice(newlineIndex + 1);
      let response: WindowsDpapiWorkerResponse;
      try {
        response = JSON.parse(line) as WindowsDpapiWorkerResponse;
      } catch {
        finish(false);
        return;
      }
      const proof = typeof response.proof === 'string'
        ? decodeCanonicalBase64(response.proof)
        : null;
      finish(
        response.type === 'authenticate'
          && proof?.byteLength === expectedProof.byteLength
          && timingSafeEqual(proof, expectedProof),
        remainder,
      );
    };
    const timeout = setTimeout(() => finish(false), PIPE_AUTH_TIMEOUT_MS);
    timeout.unref?.();
    pipe.once('error', () => finish(false));
    pipe.once('close', () => finish(false));
    pipe.on('data', onData);
    pipe.write(`${JSON.stringify({
      type: 'challenge',
      challenge: challenge.toString('base64'),
    })}\n`, 'utf8', (error) => {
      if (error) finish(false);
    });
  });
}

function childFailure(child: ChildProcessWithoutNullStreams): Promise<never> {
  return new Promise((_, reject) => {
    child.once('error', () => reject(secureCredentialCommandError('connect', 'spawn')));
    child.once('close', () => reject(secureCredentialCommandError('connect', 'child-exit')));
  });
}

function abortFailure(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return;
    const rejectAborted = () => {
      reject(secureCredentialCommandError('shutdown', 'closed', false));
    };
    if (signal.aborted) {
      rejectAborted();
      return;
    }
    signal.addEventListener('abort', rejectAborted, { once: true });
  });
}

function createWindowsPipeAddress(): WindowsDpapiPipeAddress {
  const connectionName = `open-design-dpapi-${process.pid}-${randomUUID()}`;
  return {
    connectionName,
    listenPath: `\\\\.\\pipe\\${connectionName}`,
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function positiveTimeout(input: number | undefined, fallback: number): number {
  return Number.isFinite(input) && Number(input) > 0 ? Number(input) : fallback;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  phase: WindowsDpapiWorkerPhase,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(secureCredentialCommandError(phase, 'timeout'));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(normalizeWorkerError(error, phase));
      },
    );
  });
}

function settlesBefore(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

function decodeCanonicalBase64(value: string): Buffer | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return null;
  }
  try {
    const decoded = Buffer.from(value, 'base64');
    return decoded.toString('base64') === value ? decoded : null;
  } catch {
    return null;
  }
}

function normalizeWorkerError(
  error: unknown,
  phase: WindowsDpapiWorkerPhase,
): WindowsDpapiWorkerError {
  return error instanceof WindowsDpapiWorkerError
    ? error
    : secureCredentialCommandError(phase, 'unknown');
}

function secureCredentialCommandError(
  phase: WindowsDpapiWorkerPhase,
  failureClass: WindowsDpapiWorkerFailureClass,
  fatal = true,
): WindowsDpapiWorkerError {
  return new WindowsDpapiWorkerError(phase, failureClass, fatal);
}
