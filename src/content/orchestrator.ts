import { createHash } from 'node:crypto';
import type { BookmarkRecord } from '../types.js';
import { EngineInvocationError } from '../engine.js';
import { jobInputFingerprint, type ProcessingStage } from '../jobs/state-machine.js';
import { JobStageError, type JobStageHandler } from '../jobs/worker.js';
import { discoverKnowledgeContent } from './discovery.js';
import { normalizeTranscript } from './knowledge-page.js';
import type { ContentRepository, StoredContentItem } from './repository.js';
import { buildChapters } from './synthesis/chapters.js';
import { SynthesisPipeline, type SynthesisModel } from './synthesis/pipeline.js';
import { TranscriptFallbackPipeline } from './transcripts/fallback.js';
import { TranscriptAcquisitionError, YtDlpTranscriptProvider } from './transcripts/yt-dlp.js';

const IMPLEMENTATION_VERSION: Record<ProcessingStage, number> = { metadata: 1, transcript: 1, chapters: 1, summary: 1 };

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function articleSource(text: string, language: string) {
  const paragraphs = text.split(/\n\s*\n+/).map((value) => value.trim()).filter(Boolean);
  const blocks = paragraphs.length > 1 ? paragraphs : text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((value) => value.trim()).filter(Boolean) ?? [text];
  let cursor = 0;
  const segments = blocks.map((block) => {
    const duration = Math.max(2_000, Math.round((block.split(/\s+/).length / 220) * 60_000));
    const segment = { startMs: cursor, endMs: cursor + duration, text: block };
    cursor += duration;
    return segment;
  });
  const transcript = normalizeTranscript(language, { provider: 'x-bookmarks', source: 'article-text' }, segments);
  const chapters = segments.map((segment) => ({ ...segment, label: segment.text.slice(0, 72), source: 'creator' as const }));
  return { transcript, chapters, durationMs: cursor };
}

function stageError(error: unknown): JobStageError {
  if (error instanceof JobStageError) return error;
  if (error instanceof TranscriptAcquisitionError) {
    const blocked = ['binary_missing', 'whisper_binary_missing', 'whisper_model_missing', 'ffmpeg_missing', 'authentication_required', 'restricted', 'captions_unavailable'].includes(error.code);
    return new JobStageError(error.code, `${error.message} ${error.action}`, error.retryable ? 'retry' : blocked ? 'blocked' : 'failed');
  }
  if (error instanceof EngineInvocationError) {
    const disposition = error.reason === 'spawn' ? 'blocked' : 'retry';
    return new JobStageError(`model_${error.reason}`, error.message, disposition);
  }
  return new JobStageError('invalid_stage_output', error instanceof Error ? error.message : String(error), 'failed');
}

export interface ContentOrchestratorOptions {
  repository: ContentRepository;
  metadataProvider: Pick<YtDlpTranscriptProvider, 'acquireMetadata'>;
  transcriptPipeline: Pick<TranscriptFallbackPipeline, 'acquire'>;
  model?: SynthesisModel & {
    checkSupport: ConstructorParameters<typeof SynthesisPipeline>[0]['checkSupport'];
    checkSupportBatch?: ConstructorParameters<typeof SynthesisPipeline>[0]['checkSupportBatch'];
    repairClaim?: ConstructorParameters<typeof SynthesisPipeline>[0]['repairClaim'];
  };
  now?: () => Date;
}

export class ContentOrchestrator {
  private readonly now: () => Date;

  constructor(private readonly options: ContentOrchestratorOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async discover(bookmarks: BookmarkRecord[]): Promise<{ discovered: number; enqueued: number }> {
    const discovered = discoverKnowledgeContent(bookmarks);
    let enqueued = 0;
    for (const item of discovered) {
      const now = this.now().toISOString();
      const existing = await this.options.repository.getItem(item.canonicalId);
      const article = item.type === 'article' && item.sourceText ? articleSource(item.sourceText, item.sourceLanguage ?? 'en') : null;
      const stored: StoredContentItem = existing
        ? {
          ...existing, sourceRefs: item.sourceRefs, updatedAt: now,
          ...(article ? { title: item.sourceTitle ?? existing.title, creator: item.sourceCreator ?? existing.creator, durationMs: article.durationMs, creatorChapters: article.chapters, language: item.sourceLanguage ?? existing.language } : {}),
        }
        : {
          canonicalId: item.canonicalId, canonicalUrl: item.canonicalUrl, type: item.type, ...(item.videoId ? { videoId: item.videoId } : {}), sourceRefs: item.sourceRefs,
          title: item.sourceTitle ?? 'Preparing knowledge page…', creator: item.sourceCreator ?? 'Unknown creator', durationMs: article?.durationMs ?? 0,
          ...(item.sourceLanguage ? { language: item.sourceLanguage } : {}), ...(article ? { creatorChapters: article.chapters } : {}), createdAt: now, updatedAt: now,
        };
      await this.options.repository.upsertItem(stored);
      if (article) {
        const current = await this.options.repository.getTranscript(item.canonicalId);
        if (current?.transcript.contentHash !== article.transcript.contentHash) {
          await this.options.repository.saveTranscript({ itemId: item.canonicalId, artifactHash: article.transcript.contentHash, artifactPath: `inline:x-article:${item.canonicalId}`, transcript: article.transcript, acquiredAt: now });
        }
        await this.options.repository.enqueueJob(item.canonicalId, 'chapters', jobInputFingerprint(item.canonicalId, 'chapters', [article.transcript.contentHash, hash(article.chapters)], IMPLEMENTATION_VERSION.chapters), IMPLEMENTATION_VERSION.chapters, now);
      } else {
        await this.options.repository.enqueueJob(item.canonicalId, 'metadata', jobInputFingerprint(item.canonicalId, 'metadata', [hash(item.canonicalUrl)], IMPLEMENTATION_VERSION.metadata), IMPLEMENTATION_VERSION.metadata, now);
      }
      enqueued += 1;
    }
    return { discovered: discovered.length, enqueued };
  }

  handlers(): Record<ProcessingStage, JobStageHandler> {
    return {
      metadata: async (job, signal) => {
        try {
          if (signal.aborted) throw new JobStageError('worker_stopped', 'Worker stopped.', 'retry');
          const item = await this.requiredItem(job.itemId);
          const metadata = await this.options.metadataProvider.acquireMetadata(item.canonicalUrl, signal);
          const now = this.now().toISOString();
          await this.options.repository.upsertItem({ ...item, ...metadata, canonicalId: item.canonicalId, canonicalUrl: item.canonicalUrl, type: item.type, sourceRefs: item.sourceRefs, updatedAt: now });
          const metadataHash = hash(metadata);
          await this.options.repository.enqueueJob(item.canonicalId, 'transcript', jobInputFingerprint(item.canonicalId, 'transcript', [metadataHash], IMPLEMENTATION_VERSION.transcript), IMPLEMENTATION_VERSION.transcript, now);
        } catch (error) { throw stageError(error); }
      },
      transcript: async (job, signal) => {
        try {
          const item = await this.requiredItem(job.itemId);
          const allowLong = await this.options.repository.hasLongTranscriptionOverride(item.canonicalId);
          const acquired = await this.options.transcriptPipeline.acquire(item.canonicalUrl, item.language, signal, allowLong);
          const now = this.now().toISOString();
          await this.options.repository.upsertItem({ ...item, ...acquired.media, canonicalId: item.canonicalId, canonicalUrl: item.canonicalUrl, type: item.type, sourceRefs: item.sourceRefs, updatedAt: now });
          await this.options.repository.saveTranscript({ itemId: item.canonicalId, artifactHash: acquired.transcript.contentHash, artifactPath: acquired.artifactPath, transcript: acquired.transcript, acquiredAt: now });
          const creatorHash = hash(acquired.media.creatorChapters ?? []);
          await this.options.repository.enqueueJob(item.canonicalId, 'chapters', jobInputFingerprint(item.canonicalId, 'chapters', [acquired.transcript.contentHash, creatorHash], IMPLEMENTATION_VERSION.chapters), IMPLEMENTATION_VERSION.chapters, now);
        } catch (error) { throw stageError(error); }
      },
      chapters: async (job, signal) => {
        try {
          const [item, transcript] = await Promise.all([this.requiredItem(job.itemId), this.options.repository.getTranscript(job.itemId)]);
          if (!transcript) throw new Error('Current transcript is missing.');
          const result = await buildChapters(transcript.transcript, item.durationMs, item.creatorChapters, this.options.model, signal);
          await this.options.repository.replaceChapters({ itemId: item.canonicalId, transcriptContentHash: transcript.transcript.contentHash, artifactHash: result.artifactHash, chapters: result.chapters, generation: { source: result.source, provider: this.options.model?.provider ?? 'creator' } });
          const now = this.now().toISOString();
          await this.options.repository.enqueueJob(item.canonicalId, 'summary', jobInputFingerprint(item.canonicalId, 'summary', [transcript.transcript.contentHash, result.artifactHash], IMPLEMENTATION_VERSION.summary), IMPLEMENTATION_VERSION.summary, now);
        } catch (error) { throw stageError(error); }
      },
      summary: async (job, signal) => {
        try {
          if (!this.options.model) throw new JobStageError('model_missing', 'No Field Theory synthesis model is configured.', 'blocked');
          const [transcript, chapterRecord] = await Promise.all([this.options.repository.getTranscript(job.itemId), this.options.repository.getChapters(job.itemId)]);
          if (!transcript || !chapterRecord) throw new Error('Transcript or chapters are missing.');
          const pipeline = new SynthesisPipeline({
            model: this.options.model,
            checkSupport: this.options.model.checkSupport.bind(this.options.model),
            ...(this.options.model.checkSupportBatch ? { checkSupportBatch: this.options.model.checkSupportBatch.bind(this.options.model) } : {}),
            ...(this.options.model.repairClaim ? { repairClaim: this.options.model.repairClaim.bind(this.options.model) } : {}),
            now: this.now,
            loadChunk: async (artifactId) => (await this.options.repository.getSynthesisChunk(artifactId))?.draft ?? null,
            saveChunk: async (artifactId, chunk, draft, artifactHash, createdAt) => this.options.repository.saveSynthesisChunk({
              artifactId, itemId: job.itemId, transcriptContentHash: transcript.transcript.contentHash, chunkId: chunk.id,
              provider: this.options.model!.provider, ...(this.options.model!.model ? { model: this.options.model!.model } : {}),
              promptVersion: 1, draft, artifactHash, createdAt,
            }),
          });
          const synthesis = await pipeline.synthesize(transcript.transcript, chapterRecord.chapters, signal);
          await this.options.repository.saveSummary({ itemId: job.itemId, transcriptContentHash: synthesis.transcriptContentHash, chaptersArtifactHash: chapterRecord.artifactHash, overview: synthesis.overview, details: synthesis.details, provider: synthesis.provider, ...(synthesis.model ? { model: synthesis.model } : {}), promptVersion: synthesis.promptVersion, artifactHash: synthesis.artifactHash, validationState: 'supported', createdAt: synthesis.createdAt, promotedAt: synthesis.createdAt });
        } catch (error) { throw stageError(error); }
      },
    };
  }

  private async requiredItem(itemId: string): Promise<StoredContentItem> {
    const item = await this.options.repository.getItem(itemId);
    if (!item) throw new Error(`Content item ${itemId} does not exist.`);
    return item;
  }
}
