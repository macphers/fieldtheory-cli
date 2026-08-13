import { spawn } from 'node:child_process';

export interface ProcessRequest {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

export class ProcessExecutionError extends Error {
  constructor(
    message: string,
    readonly result: ProcessResult,
    readonly reason: 'exit' | 'timeout' | 'aborted' | 'max-output' | 'spawn',
  ) {
    super(message);
    this.name = 'ProcessExecutionError';
  }
}

function terminateProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    // The child may already have exited.
  }
}

export class NodeProcessRunner implements ProcessRunner {
  async run(request: ProcessRequest): Promise<ProcessResult> {
    const timeoutMs = request.timeoutMs ?? 120_000;
    const maxOutputBytes = request.maxOutputBytes ?? 10 * 1024 * 1024;

    return new Promise((resolve, reject) => {
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let reason: ProcessExecutionError['reason'] | null = null;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;
      const child = spawn(request.command, [...request.args], {
        cwd: request.cwd,
        env: request.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const finish = (result: ProcessResult, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        request.signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(result);
      };

      const stop = (nextReason: ProcessExecutionError['reason']) => {
        if (reason) return;
        reason = nextReason;
        terminateProcessGroup(child.pid, 'SIGTERM');
        killTimer = setTimeout(() => terminateProcessGroup(child.pid, 'SIGKILL'), 2_000);
        killTimer.unref();
      };

      const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
        const combined = Buffer.concat([current, chunk]);
        if (combined.length > maxOutputBytes) stop('max-output');
        return combined.subarray(0, maxOutputBytes);
      };

      child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
      child.on('error', (error) => {
        const result = { exitCode: -1, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') };
        finish(result, new ProcessExecutionError(`Could not start ${request.command}: ${error.message}`, result, 'spawn'));
      });
      child.on('close', (code) => {
        const result = { exitCode: code ?? -1, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') };
        if (reason) {
          finish(result, new ProcessExecutionError(`${request.command} stopped: ${reason}.`, result, reason));
        } else if (result.exitCode !== 0) {
          finish(result, new ProcessExecutionError(`${request.command} exited with code ${result.exitCode}.`, result, 'exit'));
        } else {
          finish(result);
        }
      });

      const abort = () => stop('aborted');
      request.signal?.addEventListener('abort', abort, { once: true });
      if (request.signal?.aborted) abort();
      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      timer.unref();
    });
  }
}
