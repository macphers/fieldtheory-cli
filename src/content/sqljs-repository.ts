import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'sql.js';
import { openDb, saveDb } from '../db.js';
import { assertJobTransition, projectItemStatus, type JobState, type ProcessingJobSnapshot, type ProcessingStage } from '../jobs/state-machine.js';
import type {
  ActivityEvent,
  ContentRepository,
  ItemNote,
  ItemDeletionManifest,
  JobTransitionInput,
  StoredContentItem,
  TranscriptRecord,
  TranscriptSearchHit,
} from './repository.js';

const SCHEMA_VERSION = 1;

function rows(db: Database, sql: string, params: Array<string | number | null> = []): Record<string, unknown>[] {
  const result = db.exec(sql, params)[0];
  if (!result) return [];
  return result.values.map((values) => Object.fromEntries(result.columns.map((column, index) => [column, values[index]])));
}

function first(db: Database, sql: string, params: Array<string | number | null> = []): Record<string, unknown> | null {
  return rows(db, sql, params)[0] ?? null;
}

function jobFromRow(row: Record<string, unknown>): ProcessingJobSnapshot {
  return {
    id: String(row.id), itemId: String(row.item_id), stage: row.stage as ProcessingStage,
    inputFingerprint: String(row.input_fingerprint), implementationVersion: Number(row.implementation_version),
    state: row.state as JobState, attemptCount: Number(row.attempt_count),
    ...(row.next_retry_at ? { nextRetryAt: String(row.next_retry_at) } : {}),
    ...(row.lease_owner ? { leaseOwner: String(row.lease_owner) } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: String(row.lease_expires_at) } : {}),
    ...(row.started_at ? { startedAt: String(row.started_at) } : {}),
    ...(row.last_error_code ? { lastErrorCode: String(row.last_error_code) } : {}),
    ...(row.last_error_detail ? { lastErrorDetail: String(row.last_error_detail) } : {}),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function itemFromRow(db: Database, row: Record<string, unknown>): StoredContentItem {
  const sourceRefs = rows(db, 'SELECT bookmark_id, bookmark_url, discovered_at, source_url FROM source_refs WHERE item_id = ? ORDER BY discovered_at, bookmark_id', [String(row.id)])
    .map((ref) => ({ bookmarkId: String(ref.bookmark_id), bookmarkUrl: String(ref.bookmark_url), discoveredAt: String(ref.discovered_at), sourceUrl: String(ref.source_url) }));
  return {
    canonicalId: String(row.id) as `youtube:${string}`, type: 'youtube', videoId: String(row.video_id),
    canonicalUrl: String(row.canonical_url), title: String(row.title), creator: String(row.creator),
    durationMs: Number(row.duration_ms), sourceRefs, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    ...(row.thumbnail_url ? { thumbnailUrl: String(row.thumbnail_url) } : {}),
    ...(row.language ? { language: String(row.language) } : {}),
  };
}

function initializeSchema(db: Database): void {
  db.run('PRAGMA foreign_keys = ON');
  db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS content_items (
    id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type = 'youtube'), video_id TEXT NOT NULL UNIQUE,
    canonical_url TEXT NOT NULL, title TEXT NOT NULL, creator TEXT NOT NULL, duration_ms INTEGER NOT NULL,
    thumbnail_url TEXT, language TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS source_refs (
    item_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE, bookmark_id TEXT NOT NULL,
    bookmark_url TEXT NOT NULL, source_url TEXT NOT NULL, discovered_at TEXT NOT NULL,
    PRIMARY KEY(item_id, bookmark_id, source_url)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS transcripts (
    item_id TEXT PRIMARY KEY REFERENCES content_items(id) ON DELETE CASCADE, artifact_hash TEXT NOT NULL,
    artifact_path TEXT NOT NULL, content_hash TEXT NOT NULL, language TEXT NOT NULL,
    segmentation_version INTEGER NOT NULL, provider TEXT NOT NULL, provider_source TEXT NOT NULL,
    tool_version TEXT, acquired_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS transcript_segments (
    segment_id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
    start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, text TEXT NOT NULL
  )`);
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
    segment_id UNINDEXED, item_id UNINDEXED, text, tokenize='porter unicode61'
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS chapters (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
    start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, label TEXT NOT NULL, source TEXT NOT NULL,
    artifact_hash TEXT, generation_json TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS summaries (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
    transcript_content_hash TEXT NOT NULL, chapters_artifact_hash TEXT, overview_json TEXT NOT NULL,
    details_json TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, prompt_version INTEGER NOT NULL,
    artifact_hash TEXT NOT NULL, validation_state TEXT NOT NULL, created_at TEXT NOT NULL, promoted_at TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS notes (
    item_id TEXT PRIMARY KEY REFERENCES content_items(id) ON DELETE CASCADE, markdown TEXT NOT NULL,
    version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS processing_jobs (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
    stage TEXT NOT NULL, input_fingerprint TEXT NOT NULL, implementation_version INTEGER NOT NULL,
    state TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT,
    lease_owner TEXT, lease_expires_at TEXT, started_at TEXT, last_error_code TEXT, last_error_detail TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(item_id, stage, input_fingerprint, implementation_version)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS processing_jobs_queue ON processing_jobs(state, next_retry_at, created_at)`);
  db.run(`CREATE TABLE IF NOT EXISTS processing_attempts (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL, started_at TEXT NOT NULL, ended_at TEXT NOT NULL,
    outcome TEXT NOT NULL, error_code TEXT, error_detail TEXT, metadata_json TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS activity_events (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
    type TEXT NOT NULL, metadata_json TEXT, created_at TEXT NOT NULL
  )`);
  db.run(`INSERT OR IGNORE INTO meta(key, value) VALUES ('activity_enabled', 'true')`);
  db.run(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)`, [String(SCHEMA_VERSION)]);
}

export class SqlJsContentRepository implements ContentRepository {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(private readonly db: Database, private readonly filePath: string) {}

  static async open(filePath: string): Promise<SqlJsContentRepository> {
    const db = await openDb(filePath);
    initializeSchema(db);
    const repository = new SqlJsContentRepository(db, filePath);
    await repository.checkpoint();
    return repository;
  }

  private async exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.closed) throw new Error('Content repository is closed.');
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private transaction<T>(operation: () => T): T {
    this.db.run('BEGIN IMMEDIATE');
    try {
      const value = operation();
      this.db.run('COMMIT');
      saveDb(this.db, this.filePath);
      return value;
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    }
  }

  async upsertItem(item: StoredContentItem): Promise<void> {
    return this.exclusive(() => this.transaction(() => {
      this.db.run(`INSERT INTO content_items(id,type,video_id,canonical_url,title,creator,duration_ms,thumbnail_url,language,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET canonical_url=excluded.canonical_url,title=excluded.title,
        creator=excluded.creator,duration_ms=excluded.duration_ms,thumbnail_url=excluded.thumbnail_url,language=excluded.language,updated_at=excluded.updated_at`,
      [item.canonicalId, item.type, item.videoId, item.canonicalUrl, item.title, item.creator, item.durationMs, item.thumbnailUrl ?? null, item.language ?? null, item.createdAt, item.updatedAt]);
      for (const ref of item.sourceRefs) this.db.run(`INSERT OR IGNORE INTO source_refs VALUES (?,?,?,?,?)`, [item.canonicalId, ref.bookmarkId, ref.bookmarkUrl, ref.sourceUrl, ref.discoveredAt]);
    }));
  }

  async getItem(itemId: string): Promise<StoredContentItem | null> {
    return this.exclusive(() => { const row = first(this.db, 'SELECT * FROM content_items WHERE id = ?', [itemId]); return row ? itemFromRow(this.db, row) : null; });
  }

  async listItems(limit = 50, offset = 0): Promise<StoredContentItem[]> {
    return this.exclusive(() => rows(this.db, 'SELECT * FROM content_items ORDER BY updated_at DESC, id LIMIT ? OFFSET ?', [limit, offset]).map((row) => itemFromRow(this.db, row)));
  }

  async saveTranscript(record: TranscriptRecord): Promise<void> {
    return this.exclusive(() => this.transaction(() => {
      if (!first(this.db, 'SELECT id FROM content_items WHERE id = ?', [record.itemId])) throw new Error(`Unknown content item: ${record.itemId}.`);
      this.db.run('DELETE FROM transcript_fts WHERE item_id = ?', [record.itemId]);
      this.db.run('DELETE FROM transcript_segments WHERE item_id = ?', [record.itemId]);
      this.db.run(`INSERT OR REPLACE INTO transcripts VALUES (?,?,?,?,?,?,?,?,?,?)`, [
        record.itemId, record.artifactHash, record.artifactPath, record.transcript.contentHash, record.transcript.language,
        record.transcript.segmentationVersion, record.transcript.provenance.provider, record.transcript.provenance.source,
        record.transcript.provenance.toolVersion ?? null, record.acquiredAt,
      ]);
      for (const segment of record.transcript.segments) {
        this.db.run('INSERT INTO transcript_segments VALUES (?,?,?,?,?)', [segment.id, record.itemId, segment.startMs, segment.endMs, segment.text]);
        this.db.run('INSERT INTO transcript_fts(segment_id,item_id,text) VALUES (?,?,?)', [segment.id, record.itemId, segment.text]);
      }
    }));
  }

  async getTranscript(itemId: string): Promise<TranscriptRecord | null> {
    return this.exclusive(() => {
      const row = first(this.db, 'SELECT * FROM transcripts WHERE item_id = ?', [itemId]);
      if (!row) return null;
      const segments = rows(this.db, 'SELECT * FROM transcript_segments WHERE item_id = ? ORDER BY start_ms, segment_id', [itemId])
        .map((segment) => ({ id: String(segment.segment_id), startMs: Number(segment.start_ms), endMs: Number(segment.end_ms), text: String(segment.text) }));
      return {
        itemId, artifactHash: String(row.artifact_hash), artifactPath: String(row.artifact_path), acquiredAt: String(row.acquired_at),
        transcript: {
          schemaVersion: 1, language: String(row.language), segmentationVersion: 1, contentHash: String(row.content_hash),
          provenance: { provider: String(row.provider), source: row.provider_source as TranscriptRecord['transcript']['provenance']['source'], ...(row.tool_version ? { toolVersion: String(row.tool_version) } : {}) },
          segments,
        },
      };
    });
  }

  async searchTranscript(itemId: string, query: string, limit = 20): Promise<TranscriptSearchHit[]> {
    return this.exclusive(() => {
      const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
      if (tokens.length === 0) return [];
      const match = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' AND ');
      return rows(this.db, `SELECT s.segment_id,s.start_ms,s.end_ms,s.text,bm25(transcript_fts) AS rank
        FROM transcript_fts JOIN transcript_segments s ON s.segment_id=transcript_fts.segment_id
        WHERE transcript_fts MATCH ? AND transcript_fts.item_id=? ORDER BY rank LIMIT ?`, [match, itemId, limit])
        .map((row) => ({ segmentId: String(row.segment_id), startMs: Number(row.start_ms), endMs: Number(row.end_ms), text: String(row.text), rank: Number(row.rank) }));
    });
  }

  async putNote(itemId: string, markdown: string, expectedVersion: number | null, now: string): Promise<ItemNote> {
    return this.exclusive(() => this.transaction(() => {
      const current = first(this.db, 'SELECT * FROM notes WHERE item_id = ?', [itemId]);
      const version = current ? Number(current.version) : 0;
      if (expectedVersion !== null && expectedVersion !== version) throw new Error(`Note version conflict: expected ${expectedVersion}, current ${version}.`);
      const next = version + 1;
      this.db.run(`INSERT INTO notes VALUES (?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET markdown=excluded.markdown,version=excluded.version,updated_at=excluded.updated_at`,
        [itemId, markdown, next, current?.created_at ? String(current.created_at) : now, now]);
      return { itemId, markdown, version: next, createdAt: String(current?.created_at ?? now), updatedAt: now };
    }));
  }

  async getNote(itemId: string): Promise<ItemNote | null> {
    return this.exclusive(() => { const row = first(this.db, 'SELECT * FROM notes WHERE item_id = ?', [itemId]); return row ? { itemId, markdown: String(row.markdown), version: Number(row.version), createdAt: String(row.created_at), updatedAt: String(row.updated_at) } : null; });
  }

  async enqueueJob(itemId: string, stage: ProcessingStage, inputFingerprint: string, implementationVersion: number, now: string): Promise<ProcessingJobSnapshot> {
    return this.exclusive(() => this.transaction(() => {
      const id = createHash('sha256').update(`${itemId}:${stage}:${inputFingerprint}:${implementationVersion}`).digest('hex').slice(0, 32);
      this.db.run(`INSERT OR IGNORE INTO processing_jobs(id,item_id,stage,input_fingerprint,implementation_version,state,attempt_count,created_at,updated_at) VALUES (?,?,?,?,?,'queued',0,?,?)`,
        [id, itemId, stage, inputFingerprint, implementationVersion, now, now]);
      return jobFromRow(first(this.db, 'SELECT * FROM processing_jobs WHERE id = ?', [id])!);
    }));
  }

  async leaseNextJob(workerId: string, now: string, leaseMs = 60_000): Promise<ProcessingJobSnapshot | null> {
    return this.exclusive(() => this.transaction(() => {
      this.recoverExpiredLeasesSync(now);
      this.db.run(`UPDATE processing_jobs SET state='queued',updated_at=? WHERE state='retry_wait' AND next_retry_at<=?`, [now, now]);
      const row = first(this.db, `SELECT * FROM processing_jobs WHERE state='queued' AND (next_retry_at IS NULL OR next_retry_at<=?) ORDER BY created_at,id LIMIT 1`, [now]);
      if (!row) return null;
      const expires = new Date(Date.parse(now) + leaseMs).toISOString();
      this.db.run(`UPDATE processing_jobs SET state='running',attempt_count=attempt_count+1,lease_owner=?,lease_expires_at=?,started_at=?,updated_at=?,next_retry_at=NULL,last_error_code=NULL,last_error_detail=NULL WHERE id=?`, [workerId, expires, now, now, String(row.id)]);
      return jobFromRow(first(this.db, 'SELECT * FROM processing_jobs WHERE id=?', [String(row.id)])!);
    }));
  }

  async renewJobLease(jobId: string, workerId: string, now: string, leaseMs = 60_000): Promise<ProcessingJobSnapshot> {
    return this.exclusive(() => this.transaction(() => {
      const job = first(this.db, 'SELECT * FROM processing_jobs WHERE id=?', [jobId]);
      if (!job || job.state !== 'running' || job.lease_owner !== workerId) throw new Error('Job lease is not owned by this worker.');
      this.db.run('UPDATE processing_jobs SET lease_expires_at=?,updated_at=? WHERE id=?', [new Date(Date.parse(now) + leaseMs).toISOString(), now, jobId]);
      return jobFromRow(first(this.db, 'SELECT * FROM processing_jobs WHERE id=?', [jobId])!);
    }));
  }

  private transitionJobSync(jobId: string, input: JobTransitionInput): ProcessingJobSnapshot {
    const row = first(this.db, 'SELECT * FROM processing_jobs WHERE id=?', [jobId]);
    if (!row) throw new Error(`Unknown processing job: ${jobId}.`);
    const current = jobFromRow(row);
    assertJobTransition(current.state, input.state);
    if (input.state === 'retry_wait' && !input.nextRetryAt) throw new Error('retry_wait requires nextRetryAt.');
    if (current.state === 'running' && input.state !== 'running') {
      this.db.run('INSERT INTO processing_attempts VALUES (?,?,?,?,?,?,?,?,?)', [randomUUID(), jobId, current.attemptCount, current.startedAt ?? input.now, input.now, input.state, input.errorCode ?? null, input.errorDetail ?? null, null]);
    }
    this.db.run(`UPDATE processing_jobs SET state=?,next_retry_at=?,lease_owner=NULL,lease_expires_at=NULL,
      last_error_code=?,last_error_detail=?,updated_at=? WHERE id=?`,
    [input.state, input.nextRetryAt ?? null, input.errorCode ?? null, input.errorDetail ?? null, input.now, jobId]);
    return jobFromRow(first(this.db, 'SELECT * FROM processing_jobs WHERE id=?', [jobId])!);
  }

  async transitionJob(jobId: string, input: JobTransitionInput): Promise<ProcessingJobSnapshot> {
    return this.exclusive(() => this.transaction(() => this.transitionJobSync(jobId, input)));
  }

  async retryJob(jobId: string, now: string): Promise<ProcessingJobSnapshot> {
    return this.exclusive(() => this.transaction(() => {
      const row = first(this.db, 'SELECT * FROM processing_jobs WHERE id=?', [jobId]);
      if (!row) throw new Error(`Unknown processing job: ${jobId}.`);
      const state = row.state as JobState;
      if (!['failed', 'blocked', 'cancelled', 'interrupted', 'retry_wait'].includes(state)) throw new Error(`Job in ${state} cannot be retried.`);
      assertJobTransition(state, 'queued');
      this.db.run(`UPDATE processing_jobs SET state='queued',next_retry_at=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error_code=NULL,last_error_detail=NULL,updated_at=? WHERE id=?`, [now, jobId]);
      return jobFromRow(first(this.db, 'SELECT * FROM processing_jobs WHERE id=?', [jobId])!);
    }));
  }

  async listJobs(itemId?: string): Promise<ProcessingJobSnapshot[]> {
    return this.exclusive(() => rows(this.db, `SELECT * FROM processing_jobs ${itemId ? 'WHERE item_id=?' : ''} ORDER BY created_at,id`, itemId ? [itemId] : []).map(jobFromRow));
  }

  async itemStatus(itemId: string, requiredStages: readonly ProcessingStage[]): Promise<ReturnType<typeof projectItemStatus>> {
    return projectItemStatus(await this.listJobs(itemId), requiredStages);
  }

  private recoverExpiredLeasesSync(now: string): number {
    const expired = rows(this.db, `SELECT * FROM processing_jobs WHERE state='running' AND lease_expires_at<?`, [now]);
    for (const row of expired) {
      const job = jobFromRow(row);
      this.transitionJobSync(job.id, { state: 'interrupted', now, errorCode: 'lease_expired', errorDetail: 'The worker lease expired before completion.' });
      this.db.run(`UPDATE processing_jobs SET state='queued',updated_at=? WHERE id=?`, [now, job.id]);
    }
    return expired.length;
  }

  async recoverExpiredLeases(now: string): Promise<number> {
    return this.exclusive(() => this.transaction(() => this.recoverExpiredLeasesSync(now)));
  }

  async recordActivity(event: ActivityEvent): Promise<boolean> {
    return this.exclusive(() => this.transaction(() => {
      if (first(this.db, `SELECT value FROM meta WHERE key='activity_enabled'`)?.value !== 'true') return false;
      this.db.run('INSERT INTO activity_events VALUES (?,?,?,?,?)', [event.id, event.itemId, event.type, event.metadata ? JSON.stringify(event.metadata) : null, event.createdAt]);
      return true;
    }));
  }

  async setActivityEnabled(enabled: boolean): Promise<void> {
    return this.exclusive(() => this.transaction(() => { this.db.run(`INSERT OR REPLACE INTO meta VALUES ('activity_enabled',?)`, [String(enabled)]); }));
  }

  async isActivityEnabled(): Promise<boolean> {
    return this.exclusive(() => first(this.db, `SELECT value FROM meta WHERE key='activity_enabled'`)?.value === 'true');
  }

  async clearActivity(): Promise<number> {
    return this.exclusive(() => this.transaction(() => { const count = Number(first(this.db, 'SELECT COUNT(*) AS count FROM activity_events')?.count ?? 0); this.db.run('DELETE FROM activity_events'); return count; }));
  }

  async activityCount(): Promise<number> {
    return this.exclusive(() => Number(first(this.db, 'SELECT COUNT(*) AS count FROM activity_events')?.count ?? 0));
  }

  private deletionManifestSync(itemId: string): ItemDeletionManifest | null {
    const item = first(this.db, 'SELECT title FROM content_items WHERE id=?', [itemId]);
    if (!item) return null;
    const count = (table: string, column = 'item_id') => Number(first(this.db, `SELECT COUNT(*) AS count FROM ${table} WHERE ${column}=?`, [itemId])?.count ?? 0);
    const artifactPaths = rows(this.db, 'SELECT artifact_path FROM transcripts WHERE item_id=?', [itemId]).map((row) => String(row.artifact_path));
    return {
      itemId, title: String(item.title), sourceRefs: count('source_refs'), transcriptSegments: count('transcript_segments'),
      summaries: count('summaries'), chapters: count('chapters'), jobs: count('processing_jobs'),
      attempts: Number(first(this.db, `SELECT COUNT(*) AS count FROM processing_attempts WHERE job_id IN (SELECT id FROM processing_jobs WHERE item_id=?)`, [itemId])?.count ?? 0),
      activityEvents: count('activity_events'), hasNote: count('notes') > 0, artifactPaths,
    };
  }

  async deletionManifest(itemId: string): Promise<ItemDeletionManifest | null> {
    return this.exclusive(() => this.deletionManifestSync(itemId));
  }

  async deleteItem(itemId: string): Promise<ItemDeletionManifest> {
    return this.exclusive(() => {
      const manifest = this.deletionManifestSync(itemId);
      if (!manifest) throw new Error(`Unknown content item: ${itemId}.`);
      this.transaction(() => {
        this.db.run('DELETE FROM transcript_fts WHERE item_id=?', [itemId]);
        this.db.run('DELETE FROM content_items WHERE id=?', [itemId]);
      });
      const contentRoot = path.resolve(path.dirname(this.filePath));
      for (const artifactPath of manifest.artifactPaths) {
        const resolved = path.resolve(artifactPath);
        if (resolved.startsWith(`${contentRoot}${path.sep}`)) {
          try { fs.rmSync(resolved, { force: true }); } catch { /* orphan sweep will retry */ }
        }
      }
      return manifest;
    });
  }

  async checkpoint(): Promise<void> {
    return this.exclusive(() => { saveDb(this.db, this.filePath); });
  }

  async close(): Promise<void> {
    await this.exclusive(() => { saveDb(this.db, this.filePath); });
    await this.tail;
    this.db.close();
    this.closed = true;
  }
}
