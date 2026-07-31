import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'node:net';
import { createServer } from 'node:net';

const MAX_WORKER_LINE_BYTES = 64 * 1024;

// Keep one PowerShell process alive for the daemon lifetime. Packaged Windows
// can spend tens of seconds scanning each new encoded PowerShell command, so a
// process per probe/set/get/delete makes a single BYOK request exceed its IPC
// timeout even though the DPAPI calls themselves finish in milliseconds.
export type WindowsDpapiWorkerOperation = 'set' | 'get' | 'delete';

export type WindowsDpapiWorkerResult = {
  found: boolean;
  value: string | null;
};

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

while (($line = $reader.ReadLine()) -ne $null) {
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
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private inputBuffer = '';
  private nextRequestId = 0;
  private operationQueue: Promise<void> = Promise.resolve();
  private pending: {
    id: string;
    reject(error: Error): void;
    resolve(response: WindowsDpapiWorkerResponse): void;
  } | null = null;
  private closed = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly pipe: Socket,
  ) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.pipe.on('data', (chunk: Buffer) => this.acceptInput(chunk));
    this.pipe.on('error', () => this.fail());
    this.pipe.on('close', () => this.fail());
    this.child.stdout.resume();
    this.child.stderr.resume();
    this.child.on('error', () => this.fail());
    this.child.on('close', () => this.fail());
  }

  static async create(
    spawnWorker: SpawnWindowsDpapiWorker = spawn,
  ): Promise<WindowsDpapiWorker> {
    const pipeName = `open-design-dpapi-${process.pid}-${randomUUID()}`;
    const server = createServer();
    await listen(server, `\\\\.\\pipe\\${pipeName}`);
    const connection = waitForConnection(server);
    const child = spawnWorker(
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
          OD_BYOK_DPAPI_PIPE_NAME: pipeName,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    // The packaged process must not retain an open stdin stream. Requests use
    // the random per-process local pipe below, keeping plaintext credentials
    // out of argv, environment variables, and temporary files.
    child.stdin.end();
    try {
      const pipe = await Promise.race([
        connection,
        childFailure(child),
      ]);
      server.close();
      return new WindowsDpapiWorker(child, pipe);
    } catch (error) {
      server.close();
      if (!child.killed) child.kill();
      throw error;
    }
  }

  ready(): Promise<void> {
    return this.readyPromise;
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
    if (this.closed || this.pending) throw secureCredentialCommandError();
    const id = String(++this.nextRequestId);
    const request: WindowsDpapiWorkerRequest = {
      id,
      operation,
      path: Buffer.from(secretPath, 'utf8').toString('base64'),
      ...(secret === undefined
        ? {}
        : { secret: Buffer.from(secret, 'utf8').toString('base64') }),
    };
    const response = await new Promise<WindowsDpapiWorkerResponse>((resolve, reject) => {
      this.pending = { id, reject, resolve };
      this.pipe.write(`${JSON.stringify(request)}\n`, 'utf8', (error) => {
        if (error) this.fail();
      });
    });
    if (response.ok !== true || response.id !== id) {
      throw secureCredentialCommandError();
    }
    if (operation === 'get' && response.found === true) {
      if (typeof response.value !== 'string') throw secureCredentialCommandError();
      const value = Buffer.from(response.value, 'base64');
      if (value.byteLength > MAX_WORKER_LINE_BYTES) throw secureCredentialCommandError();
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
      this.fail();
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
      this.fail();
      return;
    }
    if (response.type === 'ready') {
      if (response.ok === true && this.resolveReady) {
        this.resolveReady();
        this.resolveReady = null;
        this.rejectReady = null;
        return;
      }
      this.fail();
      return;
    }
    if (!this.pending || response.id !== this.pending.id) {
      this.fail();
      return;
    }
    const pending = this.pending;
    this.pending = null;
    pending.resolve(response);
  }

  private fail(): void {
    if (this.closed) return;
    this.closed = true;
    const error = secureCredentialCommandError();
    this.rejectReady?.(error);
    this.resolveReady = null;
    this.rejectReady = null;
    this.pending?.reject(error);
    this.pending = null;
    this.pipe.destroy();
    if (!this.child.killed) this.child.kill();
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

function waitForConnection(server: Server): Promise<Socket> {
  return new Promise((resolve, reject) => {
    server.once('connection', resolve);
    server.once('error', reject);
  });
}

function childFailure(child: ChildProcessWithoutNullStreams): Promise<never> {
  return new Promise((_, reject) => {
    child.once('error', () => reject(secureCredentialCommandError()));
    child.once('close', () => reject(secureCredentialCommandError()));
  });
}

function secureCredentialCommandError(): Error {
  return new Error('Secure credential backend command failed.');
}
