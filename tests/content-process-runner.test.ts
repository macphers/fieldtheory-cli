import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeProcessRunner, ProcessExecutionError } from '../src/content/process-runner.js';

test('process runner returns bounded stdout for a successful child', async () => {
  const runner = new NodeProcessRunner();
  const result = await runner.run({ command: process.execPath, args: ['-e', 'process.stdout.write("ready")'] });
  assert.equal(result.stdout, 'ready');
  assert.equal(result.exitCode, 0);
});

test('process runner classifies non-zero, timeout, cancellation, and max-output failures', async () => {
  const runner = new NodeProcessRunner();
  await assert.rejects(runner.run({ command: process.execPath, args: ['-e', 'process.exit(7)'] }), (error: unknown) =>
    error instanceof ProcessExecutionError && error.reason === 'exit' && error.result.exitCode === 7);
  await assert.rejects(runner.run({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 20 }), (error: unknown) =>
    error instanceof ProcessExecutionError && error.reason === 'timeout');
  const controller = new AbortController();
  const pending = runner.run({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof ProcessExecutionError && error.reason === 'aborted');
  await assert.rejects(runner.run({ command: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(1000))'], maxOutputBytes: 10 }), (error: unknown) =>
    error instanceof ProcessExecutionError && error.reason === 'max-output');
});

test('process runner escalates to SIGKILL when a child ignores graceful termination', { skip: process.platform === 'win32' }, async () => {
  const runner = new NodeProcessRunner();
  const started = Date.now();
  await assert.rejects(runner.run({
    command: process.execPath,
    args: ['-e', 'process.on("SIGTERM", () => {}); process.stdout.write("started"); setInterval(() => {}, 1000)'],
    timeoutMs: 100,
  }), (error: unknown) => error instanceof ProcessExecutionError && error.reason === 'timeout');
  assert.ok(Date.now() - started < 4_000);
});
