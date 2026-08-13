import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export interface TempCleanupResult {
  inspected: number;
  removed: number;
  retained: number;
}

export async function cleanupOrphanedTempFiles(
  tempRoot: string,
  options: { olderThanMs?: number; now?: number; activePaths?: ReadonlySet<string> } = {},
): Promise<TempCleanupResult> {
  const result = { inspected: 0, removed: 0, retained: 0 };
  let entries;
  try { entries = await readdir(tempRoot, { withFileTypes: true }); }
  catch { return result; }
  const cutoff = (options.now ?? Date.now()) - (options.olderThanMs ?? 24 * 60 * 60_000);
  const active = options.activePaths ?? new Set<string>();
  for (const entry of entries) {
    const candidate = path.resolve(tempRoot, entry.name);
    result.inspected += 1;
    if (active.has(candidate)) { result.retained += 1; continue; }
    try {
      const metadata = await stat(candidate);
      if (metadata.mtimeMs >= cutoff) { result.retained += 1; continue; }
      await rm(candidate, { recursive: entry.isDirectory(), force: true });
      result.removed += 1;
    } catch { result.retained += 1; }
  }
  return result;
}
