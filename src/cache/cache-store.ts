/**
 * Persistent on-disk cache for LLM-derived artifacts.
 *
 * S65 Sprint 1 (M1 + M9 + M4). The single biggest cost lever for Phase 1B
 * extraction work and for repeated bench iteration. Three tables in one
 * SQLite DB at `fixtures/cache/cache.db`:
 *
 *   extraction_cache - Phase 1B raw-text → extracted facts (M1)
 *   judge_cache      - answer judging results (M9)
 *   embedding_cache  - BGE-small / similar text → vector (M4)
 *
 * Design choices:
 *   - **Content-addressed keys.** `prompt_version` baked into the key so
 *     prompt changes auto-bust the cache (no manual eviction).
 *   - **Idempotent schema.** `CREATE TABLE IF NOT EXISTS` lets every caller
 *     ensureSchema() at startup without coordination.
 *   - **WAL mode.** Multiple bench processes can read concurrently; write
 *     lock during inserts is brief.
 *   - **No automatic eviction.** Cache is on-disk and the contents are
 *     intended to be committed as fixtures on Preston2012/demi (per S65
 *     decision). Manual `clear()` and `vacuum()` exposed for ops.
 *   - **Cost telemetry.** Each row records the API cost the cache spared
 *     (when known). `getStats()` rolls them up for "you saved $X this run".
 *
 * Production safety: in-process LRU caches (see src/embeddings/index.ts)
 * remain. This persistent cache sits BEHIND them - only consulted on LRU
 * miss. Production prod paths are unchanged unless a caller explicitly
 * routes through the persistent cache.
 *
 * Determinism: every value stored here was generated with `temperature: 0`.
 * Prompt-cache observability hooks (src/llm/client.ts) verify that LLM
 * call sites use stable cacheKeys; this disk cache verifies the *outputs*
 * are stable across runs.
 *
 * Test isolation: pass `dbPath: ':memory:'` to construct an isolated cache.
 */

import Database from 'better-sqlite3-multiple-ciphers';
import { mkdirSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { recordCacheEvent } from '../telemetry/index.js';

export interface CacheStoreOpts {
  /** Absolute or repo-relative DB path. Defaults to fixtures/cache/cache.db. */
  dbPath?: string;
  /** Skip the on-disk file; use an in-memory DB. For tests. */
  inMemory?: boolean;
  /** Disable schema bootstrap. For tests that load fixtures pre-populated. */
  skipSchema?: boolean;
  /**
   * W4.5: 64-char hex DB encryption key. When set, the cache DB opens with
   * SQLCipher pragmas matching the memory repo's S50 dialect. Ignored for
   * `inMemory: true`. The cache stores LLM output keyed off raw prompts, so
   * it MUST be encrypted alongside the memory + telemetry DBs when vault is on.
   */
  dbEncryptionKey?: string;
}

export interface CacheStats {
  extractionRows: number;
  extractionBytes: number;
  judgeRows: number;
  judgeBytes: number;
  embeddingRows: number;
  embeddingBytes: number;
  episodeTitleRows: number;
  episodeTitleBytes: number;
  totalCostSaved: number;
}

export interface ExtractionCacheEntry<T = unknown> {
  facts: T;
  extractorModel: string;
  promptVersion: string;
  costUsd: number;
  cachedAt: string;
}

export interface EpisodeTitleCacheEntry {
  title: string;
  summary: string;
  episodeModel: string;
  costUsd: number;
  cachedAt: string;
}

export interface JudgeCacheEntry {
  verdict: string;
  judgeModel: string;
  costUsd: number;
  cachedAt: string;
}

const DEFAULT_PATH = resolve(process.cwd(), 'fixtures/cache/cache.db');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS extraction_cache (
  cache_key TEXT PRIMARY KEY,
  facts_json TEXT NOT NULL,
  extractor_model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  cached_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS judge_cache (
  cache_key TEXT PRIMARY KEY,
  verdict TEXT NOT NULL,
  judge_model TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  cached_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS episode_title_cache (
  cache_key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  episode_model TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  cached_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS embedding_cache (
  cache_key TEXT PRIMARY KEY,
  vector BLOB NOT NULL,
  dim INTEGER NOT NULL,
  model_version TEXT NOT NULL,
  cached_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ext_model ON extraction_cache(extractor_model);
CREATE INDEX IF NOT EXISTS idx_judge_model ON judge_cache(judge_model);
CREATE INDEX IF NOT EXISTS idx_emb_model ON embedding_cache(model_version);
CREATE INDEX IF NOT EXISTS idx_episode_model ON episode_title_cache(episode_model);
`;

function sha256Hex(...parts: string[]): string {
  const h = createHash('sha256');
  for (const p of parts) {
    h.update(p);
    // Length-prefix each part so 'ab'+'cd' doesn't collide with 'abc'+'d'.
    h.update('\x1f');
  }
  return h.digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

export class CacheStore {
  private db: Database.Database;
  private getExt: Database.Statement<{ key: string }>;
  private putExt: Database.Statement<{
    key: string;
    facts: string;
    model: string;
    version: string;
    cost: number;
    at: string;
  }>;
  private getJudge: Database.Statement<{ key: string }>;
  private putJudge: Database.Statement<{
    key: string;
    verdict: string;
    model: string;
    cost: number;
    at: string;
  }>;
  private getEmb: Database.Statement<{ key: string }>;
  private putEmb: Database.Statement<{
    key: string;
    vector: Buffer;
    dim: number;
    version: string;
    at: string;
  }>;
  private getEpTitle: Database.Statement<{ key: string }>;
  private putEpTitle: Database.Statement<{
    key: string;
    title: string;
    summary: string;
    model: string;
    cost: number;
    at: string;
  }>;

  constructor(opts: CacheStoreOpts = {}) {
    const dbPath = opts.inMemory ? ':memory:' : (opts.dbPath ?? DEFAULT_PATH);
    if (!opts.inMemory) {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    // W4.5: SQLCipher pragmas BEFORE any other pragma or DDL.
    if (opts.dbEncryptionKey && !opts.inMemory) {
      this.db.pragma(`key = "x'${opts.dbEncryptionKey}'"`);
      this.db.pragma('cipher_compatibility = 4');
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    if (!opts.skipSchema) {
      this.db.exec(SCHEMA_SQL);
    }

    this.getExt = this.db.prepare(
      'SELECT facts_json, extractor_model, prompt_version, cost_usd, cached_at FROM extraction_cache WHERE cache_key = @key',
    );
    this.putExt = this.db.prepare(
      'INSERT OR REPLACE INTO extraction_cache (cache_key, facts_json, extractor_model, prompt_version, cost_usd, cached_at) VALUES (@key, @facts, @model, @version, @cost, @at)',
    );
    this.getJudge = this.db.prepare(
      'SELECT verdict, judge_model, cost_usd, cached_at FROM judge_cache WHERE cache_key = @key',
    );
    this.putJudge = this.db.prepare(
      'INSERT OR REPLACE INTO judge_cache (cache_key, verdict, judge_model, cost_usd, cached_at) VALUES (@key, @verdict, @model, @cost, @at)',
    );
    this.getEmb = this.db.prepare(
      'SELECT vector, dim, model_version, cached_at FROM embedding_cache WHERE cache_key = @key',
    );
    this.putEmb = this.db.prepare(
      'INSERT OR REPLACE INTO embedding_cache (cache_key, vector, dim, model_version, cached_at) VALUES (@key, @vector, @dim, @version, @at)',
    );

    this.getEpTitle = this.db.prepare(
      'SELECT title, summary, episode_model, cost_usd, cached_at FROM episode_title_cache WHERE cache_key = @key',
    );
    this.putEpTitle = this.db.prepare(
      'INSERT OR REPLACE INTO episode_title_cache (cache_key, title, summary, episode_model, cost_usd, cached_at) VALUES (@key, @title, @summary, @model, @cost, @at)',
    );
  }

  // --- Extraction (M1) -----------------------------------------------------

  /**
   * Build a stable cache key for an extraction call.
   * promptVersion bumps invalidate the cache automatically.
   */
  static extractionKey(input: string, extractorModel: string, promptVersion: string): string {
    return sha256Hex('ext', extractorModel, promptVersion, input);
  }

  getExtraction<T = unknown>(
    input: string,
    extractorModel: string,
    promptVersion: string,
  ): ExtractionCacheEntry<T> | null {
    const key = CacheStore.extractionKey(input, extractorModel, promptVersion);
    const row = this.getExt.get({ key }) as
      | { facts_json: string; extractor_model: string; prompt_version: string; cost_usd: number; cached_at: string }
      | undefined;
    recordCacheEvent({
      cache_name: 'extraction',
      event: row ? 'hit' : 'miss',
      key_excerpt: key.slice(0, 32),
    });
    if (!row) return null;
    return {
      facts: JSON.parse(row.facts_json) as T,
      extractorModel: row.extractor_model,
      promptVersion: row.prompt_version,
      costUsd: row.cost_usd,
      cachedAt: row.cached_at,
    };
  }

  putExtraction<T = unknown>(
    input: string,
    extractorModel: string,
    promptVersion: string,
    facts: T,
    costUsd = 0,
  ): void {
    const key = CacheStore.extractionKey(input, extractorModel, promptVersion);
    this.putExt.run({
      key,
      facts: JSON.stringify(facts),
      model: extractorModel,
      version: promptVersion,
      cost: costUsd,
      at: nowIso(),
    });
  }

  // --- Judge (M9) ----------------------------------------------------------

  /**
   * Build a stable cache key for a judge call. Includes the predicted answer
   * so iteration replays of the same Q with a *different* predicted answer
   * miss the cache (correctly).
   */
  static judgeKey(judgeModel: string, system: string, userPrompt: string, predicted: string): string {
    return sha256Hex('judge', judgeModel, system, userPrompt, predicted);
  }

  getJudgeResult(judgeModel: string, system: string, userPrompt: string, predicted: string): JudgeCacheEntry | null {
    const key = CacheStore.judgeKey(judgeModel, system, userPrompt, predicted);
    const row = this.getJudge.get({ key }) as
      | { verdict: string; judge_model: string; cost_usd: number; cached_at: string }
      | undefined;
    recordCacheEvent({
      cache_name: 'judge',
      event: row ? 'hit' : 'miss',
      key_excerpt: key.slice(0, 32),
    });
    if (!row) return null;
    return {
      verdict: row.verdict,
      judgeModel: row.judge_model,
      costUsd: row.cost_usd,
      cachedAt: row.cached_at,
    };
  }

  putJudgeResult(
    judgeModel: string,
    system: string,
    userPrompt: string,
    predicted: string,
    verdict: string,
    costUsd = 0,
  ): void {
    const key = CacheStore.judgeKey(judgeModel, system, userPrompt, predicted);
    this.putJudge.run({ key, verdict, model: judgeModel, cost: costUsd, at: nowIso() });
  }

  // --- Embedding (M4) ------------------------------------------------------

  /**
   * Build a stable cache key for an embedding call.
   * model_version is whatever string identifies the embedding model and any
   * tokenization strategy (e.g. 'bge-small-en-v1.5-onnx-fp32').
   */
  static embeddingKey(text: string, modelVersion: string): string {
    return sha256Hex('emb', modelVersion, text);
  }

  getEmbedding(text: string, modelVersion: string): { vector: number[]; cachedAt: string } | null {
    const key = CacheStore.embeddingKey(text, modelVersion);
    const row = this.getEmb.get({ key }) as
      | { vector: Buffer; dim: number; model_version: string; cached_at: string }
      | undefined;
    recordCacheEvent({
      cache_name: 'embedding',
      event: row ? 'hit' : 'miss',
      key_excerpt: key.slice(0, 32),
    });
    if (!row) return null;
    // Float32Array view over the BLOB → number[] for the existing API contract.
    const f32 = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.dim);
    return { vector: Array.from(f32), cachedAt: row.cached_at };
  }

  putEmbedding(text: string, modelVersion: string, vector: number[]): void {
    const key = CacheStore.embeddingKey(text, modelVersion);
    const f32 = new Float32Array(vector);
    const buf = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
    this.putEmb.run({ key, vector: buf, dim: vector.length, version: modelVersion, at: nowIso() });
  }

  // --- Episode title (S71 T4) ---------------------------------------------

  /**
   * Build a stable cache key for an episode title/summary call.
   *
   * Per brain #2215. Subject + sorted claims is the natural key - generation
   * is order-invariant over claims and the prompt is parameter-free beyond
   * subject + claims. Model + version baked in so swapping EPISODE_TITLE_MODEL
   * busts the cache. v1 reserves room for a future v2 if the prompt format
   * changes.
   */
  static episodeTitleKey(subject: string, claims: string[], episodeModel: string): string {
    const sortedClaims = claims.slice().sort();
    return sha256Hex('episode-title', 'v1', episodeModel, subject, JSON.stringify(sortedClaims));
  }

  getEpisodeTitle(subject: string, claims: string[], episodeModel: string): EpisodeTitleCacheEntry | null {
    const key = CacheStore.episodeTitleKey(subject, claims, episodeModel);
    const row = this.getEpTitle.get({ key }) as
      | { title: string; summary: string; episode_model: string; cost_usd: number; cached_at: string }
      | undefined;
    recordCacheEvent({
      cache_name: 'episode_title',
      event: row ? 'hit' : 'miss',
      key_excerpt: key.slice(0, 32),
    });
    if (!row) return null;
    return {
      title: row.title,
      summary: row.summary,
      episodeModel: row.episode_model,
      costUsd: row.cost_usd,
      cachedAt: row.cached_at,
    };
  }

  putEpisodeTitle(
    subject: string,
    claims: string[],
    episodeModel: string,
    title: string,
    summary: string,
    costUsd = 0,
  ): void {
    const key = CacheStore.episodeTitleKey(subject, claims, episodeModel);
    this.putEpTitle.run({
      key,
      title,
      summary,
      model: episodeModel,
      cost: costUsd,
      at: nowIso(),
    });
  }

  /**
   * Count rows in episode_title_cache. Used by cache-warm probes.
   */
  countEpisodeTitle(): { rows: number; lastWriteIso: string | null } {
    const r = this.db.prepare('SELECT COUNT(*) as c, MAX(cached_at) as m FROM episode_title_cache').get() as {
      c: number;
      m: string | null;
    };
    return { rows: r.c, lastWriteIso: r.m };
  }

  // --- Ops -----------------------------------------------------------------

  // --- Probe queries (S68 cache-warm probe) -----------------------------

  /**
   * Count rows matching a judge_model prefix. callJudgeCached stores
   * `judge:<bench>:<model>` so passing 'judge:lme' counts every LME judge
   * entry regardless of which judge model. Empty string = total count.
   */
  countJudgeByTagPrefix(prefix: string): { rows: number; lastWriteIso: string | null } {
    if (prefix === '') {
      const r = this.db.prepare('SELECT COUNT(*) as c, MAX(cached_at) as m FROM judge_cache').get() as {
        c: number;
        m: string | null;
      };
      return { rows: r.c, lastWriteIso: r.m };
    }
    const r = this.db
      .prepare('SELECT COUNT(*) as c, MAX(cached_at) as m FROM judge_cache WHERE judge_model LIKE @p')
      .get({ p: prefix + '%' }) as { c: number; m: string | null };
    return { rows: r.c, lastWriteIso: r.m };
  }

  /**
   * Count rows in extraction_cache, optionally filtered by extractor_model.
   * Extraction is not bench-scoped (one extraction per session covers all
   * benches that consume that session) so prefix is usually omitted.
   */
  countExtractionByModelPrefix(modelPrefix?: string): { rows: number; lastWriteIso: string | null } {
    if (!modelPrefix) {
      const r = this.db.prepare('SELECT COUNT(*) as c, MAX(cached_at) as m FROM extraction_cache').get() as {
        c: number;
        m: string | null;
      };
      return { rows: r.c, lastWriteIso: r.m };
    }
    const r = this.db
      .prepare('SELECT COUNT(*) as c, MAX(cached_at) as m FROM extraction_cache WHERE extractor_model LIKE @p')
      .get({ p: modelPrefix + '%' }) as { c: number; m: string | null };
    return { rows: r.c, lastWriteIso: r.m };
  }

  /**
   * Count embedding_cache rows. Embeddings are global (BGE model output)
   * and shared across all benches.
   */
  countEmbedding(): { rows: number; lastWriteIso: string | null } {
    const r = this.db.prepare('SELECT COUNT(*) as c, MAX(cached_at) as m FROM embedding_cache').get() as {
      c: number;
      m: string | null;
    };
    return { rows: r.c, lastWriteIso: r.m };
  }

  // --- Stats ---------------------------------------------------------------

  getStats(): CacheStats {
    const ext = this.db
      .prepare(
        'SELECT COUNT(*) as rows, COALESCE(SUM(LENGTH(facts_json)), 0) as bytes, COALESCE(SUM(cost_usd), 0) as cost FROM extraction_cache',
      )
      .get() as { rows: number; bytes: number; cost: number };
    const judge = this.db
      .prepare(
        'SELECT COUNT(*) as rows, COALESCE(SUM(LENGTH(verdict)), 0) as bytes, COALESCE(SUM(cost_usd), 0) as cost FROM judge_cache',
      )
      .get() as { rows: number; bytes: number; cost: number };
    const emb = this.db
      .prepare('SELECT COUNT(*) as rows, COALESCE(SUM(LENGTH(vector)), 0) as bytes FROM embedding_cache')
      .get() as { rows: number; bytes: number };
    const epTitle = this.db
      .prepare(
        'SELECT COUNT(*) as rows, COALESCE(SUM(LENGTH(title) + LENGTH(summary)), 0) as bytes, COALESCE(SUM(cost_usd), 0) as cost FROM episode_title_cache',
      )
      .get() as { rows: number; bytes: number; cost: number };
    return {
      extractionRows: ext.rows,
      extractionBytes: ext.bytes,
      judgeRows: judge.rows,
      judgeBytes: judge.bytes,
      embeddingRows: emb.rows,
      embeddingBytes: emb.bytes,
      episodeTitleRows: epTitle.rows,
      episodeTitleBytes: epTitle.bytes,
      totalCostSaved: ext.cost + judge.cost + epTitle.cost,
    };
  }

  /** Wipe a single table. Use prompt-version bumping in normal flow instead. */
  clearTable(table: 'extraction_cache' | 'judge_cache' | 'embedding_cache' | 'episode_title_cache'): number {
    const changes = this.db.prepare(`DELETE FROM ${table}`).run().changes;
    const cacheName =
      table === 'extraction_cache'
        ? 'extraction'
        : table === 'judge_cache'
          ? 'judge'
          : table === 'embedding_cache'
            ? 'embedding'
            : 'episode_title';
    recordCacheEvent({ cache_name: cacheName, event: 'evict' });
    return changes;
  }

  /** Reclaim unused space after a clear. */
  vacuum(): void {
    this.db.exec('VACUUM');
  }

  close(): void {
    this.db.close();
  }
}

// --- Module-level singleton (lazy) ---------------------------------------

let _shared: CacheStore | null = null;

/**
 * Get or initialize the shared CacheStore instance. Most call sites should
 * use this rather than constructing their own. The singleton respects
 * `DEMIURGE_CACHE_DB` env var for path override; tests that need isolation
 * should pass `inMemory: true` to a fresh `new CacheStore({ inMemory: true })`.
 */
export function getSharedCache(): CacheStore {
  if (!_shared) {
    const path = process.env.DEMIURGE_CACHE_DB || DEFAULT_PATH;
    // W4.5: when the engine's DB key is set (via vault KeySource or the S50
    // env path), apply the same key to the cache DB. Read the env directly
    // here because `config` is not visible to this module and the cache is
    // lazily constructed on first reference.
    let dbEncryptionKey =
      process.env.DEMIURGE_DB_KEY && process.env.DEMIURGE_DB_KEY.length > 0 ? process.env.DEMIURGE_DB_KEY : undefined;
    // S78 #3124: applying a SQLCipher key to a plaintext cache throws
    // SQLITE_NOTADB and kills bench runs at cache-warm. If an existing cache
    // file carries the plaintext "SQLite format 3" header, do not apply the
    // key (open it plaintext). New or actually-encrypted caches still get it.
    if (dbEncryptionKey && path !== ':memory:' && existsSync(path)) {
      try {
        const fd = openSync(path, 'r');
        const header = Buffer.alloc(16);
        readSync(fd, header, 0, 16, 0);
        closeSync(fd);
        if (header.toString('utf8').startsWith('SQLite format 3')) {
          dbEncryptionKey = undefined;
        }
      } catch {
        // header unreadable: fall through and let the constructor try the key
      }
    }
    _shared = new CacheStore({ dbPath: path, dbEncryptionKey });
  }
  return _shared;
}

/**
 * Disable / reset the shared cache. For tests that need to swap in a
 * fresh instance, or for shutdown.
 */
export function resetSharedCache(): void {
  if (_shared) {
    _shared.close();
    _shared = null;
  }
}
