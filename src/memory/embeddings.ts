import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDir } from '../paths.js';
import type { ContentRepository } from '../content/repository.js';

export const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIMENSIONS = 384;
export const REPRESENTATION_VERSION = 1;

interface VectorRecord { itemId: string; contentHash: string; vector: number[]; }
interface VectorGeneration { version: 1; generationId: string; model: string; dimensions: number; representationVersion: number; createdAt: string; vectors: VectorRecord[]; }

export interface Embedder { embed(text: string): Promise<number[]>; }

function cacheRoot(): string { return path.join(dataDir(), 'models'); }
function generationPath(): string { return path.join(dataDir(), 'memory-vectors.json'); }
function installMarkerPath(): string { return path.join(cacheRoot(), 'all-MiniLM-L6-v2.installed.json'); }

async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) { dot += left[index] * right[index]; leftNorm += left[index] ** 2; rightNorm += right[index] ** 2; }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

export function deterministicClusters(records: VectorRecord[], count: number, iterations = 12): Array<{ id: string; itemIds: string[]; centroid: number[] }> {
  if (records.length === 0) return [];
  const k = Math.max(1, Math.min(count, records.length));
  const sorted = [...records].sort((a, b) => a.itemId.localeCompare(b.itemId));
  let centroids = Array.from({ length: k }, (_value, index) => [...sorted[Math.floor(index * sorted.length / k)].vector]);
  let assignments = new Array<number>(sorted.length).fill(0);
  for (let round = 0; round < iterations; round += 1) {
    assignments = sorted.map((record) => centroids.reduce((best, centroid, index) => cosine(record.vector, centroid) > cosine(record.vector, centroids[best]) ? index : best, 0));
    centroids = centroids.map((centroid, cluster) => {
      const members = sorted.filter((_record, index) => assignments[index] === cluster);
      if (members.length === 0) return centroid;
      return centroid.map((_value, dimension) => members.reduce((sum, member) => sum + member.vector[dimension], 0) / members.length);
    });
  }
  return centroids.map((centroid, index) => ({ id: `semantic:${index + 1}`, centroid, itemIds: sorted.filter((_record, recordIndex) => assignments[recordIndex] === index).map((record) => record.itemId) })).filter((cluster) => cluster.itemIds.length > 0);
}

export class LocalEmbeddingService {
  constructor(private readonly repository: ContentRepository, private readonly options: { embedder?: Embedder; generationFile?: string; markerFile?: string } = {}) {}

  private async createEmbedder(remote: boolean): Promise<Embedder> {
    if (this.options.embedder) return this.options.embedder;
    const transformers = await import('@huggingface/transformers');
    transformers.env.cacheDir = cacheRoot();
    transformers.env.allowRemoteModels = remote;
    transformers.env.allowLocalModels = true;
    const extractor = await transformers.pipeline('feature-extraction', DEFAULT_EMBEDDING_MODEL, { dtype: 'fp32', device: 'cpu', local_files_only: !remote });
    return {
      embed: async (text: string) => {
        const tensor = await extractor(text, { pooling: 'mean', normalize: true });
        const values = tensor.tolist() as number[][];
        const vector = Array.isArray(values[0]) ? values[0] : values as unknown as number[];
        if (vector.length !== EMBEDDING_DIMENSIONS || vector.some((value) => !Number.isFinite(value))) throw new Error('embedding_dimension_mismatch');
        return vector;
      },
    };
  }

  async install(): Promise<{ model: string; dimensions: number; cache: string }> {
    const embedder = await this.createEmbedder(true);
    await embedder.embed('Field Theory local semantic model installation check.');
    const value = { model: DEFAULT_EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS, installedAt: new Date().toISOString(), cache: cacheRoot() };
    await atomicJson(this.options.markerFile ?? installMarkerPath(), value);
    return value;
  }

  async status(): Promise<{ installed: boolean; model: string; dimensions: number; generation?: { id: string; coverage: number; createdAt: string } }> {
    let installed = false;
    try { JSON.parse(await readFile(this.options.markerFile ?? installMarkerPath(), 'utf8')); installed = true; } catch { /* absent is a supported degraded state */ }
    const generation = await this.loadGeneration();
    const items = await this.repository.listItems(100_000, 0);
    return { installed, model: DEFAULT_EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS, ...(generation ? { generation: { id: generation.generationId, coverage: items.length ? generation.vectors.length / items.length : 1, createdAt: generation.createdAt } } : {}) };
  }

  async rebuild(): Promise<{ generationId: string; vectors: number }> {
    const embedder = await this.createEmbedder(false);
    const items = await this.repository.listItems(100_000, 0);
    const vectors: VectorRecord[] = [];
    for (const item of items) {
      const transcript = await this.repository.getTranscript(item.canonicalId);
      if (!transcript) continue;
      const representation = `${item.title}\n${item.creator}\n${transcript.transcript.segments.map((segment) => segment.text).join(' ').slice(0, 12_000)}`;
      vectors.push({ itemId: item.canonicalId, contentHash: transcript.transcript.contentHash, vector: await embedder.embed(representation) });
    }
    const generation: VectorGeneration = { version: 1, generationId: randomUUID(), model: DEFAULT_EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS, representationVersion: REPRESENTATION_VERSION, createdAt: new Date().toISOString(), vectors };
    await atomicJson(this.options.generationFile ?? generationPath(), generation);
    return { generationId: generation.generationId, vectors: vectors.length };
  }

  async semanticSearch(query: string, limit = 20): Promise<Array<{ itemId: string; score: number }>> {
    const generation = await this.loadGeneration();
    if (!generation) return [];
    const queryVector = await (await this.createEmbedder(false)).embed(query);
    return generation.vectors.map((record) => ({ itemId: record.itemId, score: cosine(queryVector, record.vector) })).sort((a, b) => b.score - a.score || a.itemId.localeCompare(b.itemId)).slice(0, limit);
  }

  async clusters(count = 8): Promise<Array<{ id: string; itemIds: string[]; centroid: number[] }>> {
    return deterministicClusters((await this.loadGeneration())?.vectors ?? [], count);
  }

  async uninstall(): Promise<void> {
    await rm(this.options.markerFile ?? installMarkerPath(), { force: true });
    await rm(cacheRoot(), { recursive: true, force: true });
  }

  private async loadGeneration(): Promise<VectorGeneration | null> {
    try {
      const generation = JSON.parse(await readFile(this.options.generationFile ?? generationPath(), 'utf8')) as VectorGeneration;
      if (generation.version !== 1 || generation.dimensions !== EMBEDDING_DIMENSIONS || generation.model !== DEFAULT_EMBEDDING_MODEL || generation.vectors.some((record) => record.vector.length !== EMBEDDING_DIMENSIONS)) return null;
      return generation;
    } catch { return null; }
  }
}
