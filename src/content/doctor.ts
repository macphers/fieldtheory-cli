import { access, constants, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProcessRunner } from './process-runner.js';

export type DependencyState = 'ready' | 'missing' | 'unsupported';

export interface DependencyCheck {
  name: 'yt-dlp' | 'ffmpeg' | 'whisper.cpp' | 'whisper-model' | 'content-storage';
  state: DependencyState;
  version?: string;
  location?: string;
  action?: string;
}

export interface ContentDoctorOptions {
  runner: ProcessRunner;
  contentRoot: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
}

async function executableCheck(runner: ProcessRunner, name: DependencyCheck['name'], command: string, args: string[]): Promise<DependencyCheck> {
  try {
    const result = await runner.run({ command, args, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
    return { name, state: 'ready', version: (result.stdout || result.stderr).split('\n')[0].trim(), location: command };
  } catch {
    return { name, state: 'missing', location: command, action: `Install ${name} and ensure ${command} is executable.` };
  }
}

export async function inspectContentDependencies(options: ContentDoctorOptions): Promise<DependencyCheck[]> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const whisperBinary = env.FT_WHISPER_CPP_PATH ?? 'whisper-cli';
  const whisperModel = env.FT_WHISPER_MODEL;
  const checks = await Promise.all([
    executableCheck(options.runner, 'yt-dlp', env.FT_YTDLP_PATH ?? 'yt-dlp', ['--version']),
    executableCheck(options.runner, 'ffmpeg', env.FT_FFMPEG_PATH ?? 'ffmpeg', ['-version']),
    executableCheck(options.runner, 'whisper.cpp', whisperBinary, ['--help']),
  ]);

  const whisper = checks[2];
  if (whisper.state === 'ready' && platform === 'darwin' && arch !== 'arm64') {
    checks[2] = { ...whisper, state: 'unsupported', action: 'Local transcription currently requires an Apple Silicon Mac.' };
  }

  if (!whisperModel) {
    checks.push({ name: 'whisper-model', state: 'missing', action: 'Set FT_WHISPER_MODEL to an explicitly installed whisper.cpp model file.' });
  } else {
    try {
      await access(whisperModel, constants.R_OK);
      const model = await stat(whisperModel);
      checks.push({ name: 'whisper-model', state: model.isFile() ? 'ready' : 'unsupported', location: whisperModel });
    } catch {
      checks.push({ name: 'whisper-model', state: 'missing', location: whisperModel, action: 'Install the configured model or update FT_WHISPER_MODEL.' });
    }
  }

  try {
    await access(path.dirname(options.contentRoot), constants.W_OK);
    checks.push({ name: 'content-storage', state: 'ready', location: options.contentRoot });
  } catch {
    checks.push({ name: 'content-storage', state: 'missing', location: options.contentRoot, action: `Make ${path.dirname(options.contentRoot)} writable. Free space is also required under ${os.tmpdir()}.` });
  }
  return checks;
}
