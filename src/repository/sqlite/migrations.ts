import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3-multiple-ciphers';

import { computeEntryHash } from '../audit-log.js';

/**
 * Schema version stamped into system_metadata by runMigrations (R29 WB-1).
 * Bump when a future migration changes the on-disk shape in a way the
 * verifier or operators need to reason about.
 */
export const SCHEMA_VERSION = '2026-06-r29-wb';

/**
 * Stable identifier for the epoch-migration logic, recorded in the epoch
 * event's details so a future reader can tell which migration drew the
 * boundary. Bump only if the epoch computation itself changes.
 */
export const EPOCH_MIGRATION_CODE = 'r29-wb1-epoch-v1';

/**
 * Audit action literal for the epoch marker. Mirrors
 * AuditAction.CHAIN_EPOCH_MIGRATED; kept as a local literal so this DDL
 * module does not import the schema layer.
 */
const AUDIT_EPOCH_ACTION = 'chain-epoch-migrated';

/**
 * All DDL lives here. Run once at boot via initialize().
 * Order matters. Tables before indexes before FTS before vec.
 *
 * sqlite-vec virtual table uses float[${embeddingDim}] for BGE-small embeddings.
 * FTS5 uses porter tokenizer for English stemming on claim + subject.
 */
export function runMigrations(db: Database.Database): void {
  db.exec(`
    -- Core memory table
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      claim TEXT NOT NULL,
      subject TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'global',
      valid_from TEXT,
      valid_to TEXT,
      provenance TEXT NOT NULL,
      trust_class TEXT NOT NULL,
      confidence REAL NOT NULL,
      source_hash TEXT NOT NULL,
      supersedes TEXT,
      conflicts_with TEXT NOT NULL DEFAULT '[]',
      review_status TEXT NOT NULL DEFAULT 'pending',
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      permanence_status TEXT NOT NULL DEFAULT 'provisional',
      deleted_at TEXT,
      delete_reason TEXT,

      -- Hub-and-spoke (Novel Council: Fractal Hub-and-Spoke)
      hub_id TEXT,
      hub_score REAL NOT NULL DEFAULT 0.0,
      resolution INTEGER NOT NULL DEFAULT 3,
      memory_type TEXT NOT NULL DEFAULT 'declarative',

      -- Versioning (Novel Council: Memory Versioning)
      version_number INTEGER NOT NULL DEFAULT 1,
      parent_version_id TEXT,

      -- Decay management (Novel Council: Decay + Pause)
      frozen_at TEXT,
      decay_score REAL NOT NULL DEFAULT 1.0,
      storage_tier TEXT NOT NULL DEFAULT 'active',

      -- Inhibitory memory + interference
      is_inhibitory INTEGER NOT NULL DEFAULT 0,
      inhibition_target TEXT,
      interference_status TEXT NOT NULL DEFAULT 'active',

      -- Correction tracking
      correction_count INTEGER NOT NULL DEFAULT 0,

      -- Freeze flag
      is_frozen INTEGER NOT NULL DEFAULT 0,

      -- Causal/narrative chains
      caused_by TEXT,
      leads_to TEXT,

      -- Fact-Family Collapse
      canonical_fact_id TEXT,
      is_canonical INTEGER NOT NULL DEFAULT 1,

      CHECK (confidence >= 0.0 AND confidence <= 1.0),
      CHECK (scope IN ('global', 'project', 'session')),
      CHECK (provenance IN ('user-confirmed', 'llm-extracted-confident', 'llm-extracted-quarantine', 'imported')),
      CHECK (trust_class IN ('confirmed', 'auto-approved', 'quarantined', 'rejected')),
      CHECK (review_status IN ('approved', 'pending', 'rejected')),
      CHECK (permanence_status IN ('provisional', 'permanent', 'promotion-pending')),
      CHECK (hub_score >= 0.0 AND hub_score <= 1.0),
      CHECK (resolution IN (1, 2, 3)),
      CHECK (memory_type IN ('declarative', 'procedural', 'constraint')),
      CHECK (decay_score >= 0.0 AND decay_score <= 1.0),
      CHECK (storage_tier IN ('active', 'cold', 'archive')),
      CHECK (interference_status IN ('active', 'cold', 'archived'))
    );

    -- Indexes for common query patterns
    CREATE INDEX IF NOT EXISTS idx_memories_trust_class ON memories(trust_class) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_memories_review_status ON memories(review_status) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_memories_subject ON memories(subject) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_memories_source_hash ON memories(source_hash);
    CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
    CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at);
    CREATE INDEX IF NOT EXISTS idx_memories_supersedes ON memories(supersedes) WHERE supersedes IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_memories_permanence ON memories(permanence_status) WHERE deleted_at IS NULL;

    -- Hub-and-spoke indexes
    CREATE INDEX IF NOT EXISTS idx_memories_hub_id ON memories(hub_id) WHERE hub_id IS NOT NULL AND deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_memories_resolution ON memories(resolution) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_memories_hub_score ON memories(hub_score) WHERE hub_score > 0.5 AND deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_memories_memory_type ON memories(memory_type) WHERE deleted_at IS NULL;

    -- Versioning indexes
    CREATE INDEX IF NOT EXISTS idx_memories_parent_version ON memories(parent_version_id) WHERE parent_version_id IS NOT NULL;

    -- Decay indexes
    CREATE INDEX IF NOT EXISTS idx_memories_storage_tier ON memories(storage_tier) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_memories_frozen ON memories(frozen_at) WHERE frozen_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_memories_decay ON memories(decay_score) WHERE deleted_at IS NULL AND storage_tier = 'active';

    -- FTS5 for lexical search (claim + subject, porter stemmer)
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      claim,
      subject,
      content='memories',
      content_rowid='rowid',
      tokenize='porter'
    );

    -- FTS sync triggers: keep FTS index in sync with memories table
    CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, claim, subject)
      VALUES (NEW.rowid, NEW.claim, NEW.subject);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, claim, subject)
      VALUES ('delete', OLD.rowid, OLD.claim, OLD.subject);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE OF claim, subject ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, claim, subject)
      VALUES ('delete', OLD.rowid, OLD.claim, OLD.subject);
      INSERT INTO memories_fts(rowid, claim, subject)
      VALUES (NEW.rowid, NEW.claim, NEW.subject);
    END;

    -- Audit log (append-only, hash-chained)
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      memory_id TEXT,
      action TEXT NOT NULL,
      details TEXT,
      previous_hash TEXT,
      hash TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_memory_id ON audit_log(memory_id) WHERE memory_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);

    -- Spot check tracking
    CREATE TABLE IF NOT EXISTS spot_checks (
      memory_id TEXT PRIMARY KEY,
      flagged_at TEXT NOT NULL,
      reviewed_at TEXT,
      FOREIGN KEY (memory_id) REFERENCES memories(id)
    );

    -- System metadata (key-value store for circuit breaker, etc.)
    CREATE TABLE IF NOT EXISTS system_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Memory edges: hub-spoke links + cross-domain bridges (Novel Council: Fractal Hub-and-Spoke)
    CREATE TABLE IF NOT EXISTS memory_edges (
      id TEXT PRIMARY KEY,
      src_id TEXT NOT NULL,
      dst_id TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      shared_principle TEXT,
      provenance_count INTEGER NOT NULL DEFAULT 1,
      auto_discovered INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_validated_at TEXT NOT NULL,

      CHECK (edge_type IN ('hub-spoke', 'cross-domain', 'causal-cause', 'causal-effect')),
      CHECK (weight >= 0.0 AND weight <= 1.0),
      FOREIGN KEY (src_id) REFERENCES memories(id),
      FOREIGN KEY (dst_id) REFERENCES memories(id)
    );

    CREATE INDEX IF NOT EXISTS idx_edges_src ON memory_edges(src_id);
    CREATE INDEX IF NOT EXISTS idx_edges_dst ON memory_edges(dst_id);
    CREATE INDEX IF NOT EXISTS idx_edges_type ON memory_edges(edge_type);
    CREATE INDEX IF NOT EXISTS idx_edges_principle ON memory_edges(shared_principle) WHERE shared_principle IS NOT NULL;

    -- Structural tags for cross-domain discovery (Novel Council: Fractal Hub-and-Spoke)
    CREATE TABLE IF NOT EXISTS structural_tags (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      strength REAL NOT NULL DEFAULT 1.0,
      created_at TEXT NOT NULL,

      CHECK (strength >= 0.0 AND strength <= 1.0),
      FOREIGN KEY (memory_id) REFERENCES memories(id)
    );

    CREATE INDEX IF NOT EXISTS idx_tags_memory ON structural_tags(memory_id);
    CREATE INDEX IF NOT EXISTS idx_tags_tag ON structural_tags(tag);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_unique ON structural_tags(memory_id, tag);

    -- Hub stats materialized helper (Novel Council: Fractal Hub-and-Spoke)
    CREATE TABLE IF NOT EXISTS hub_stats (
      hub_id TEXT PRIMARY KEY,
      spoke_count INTEGER NOT NULL DEFAULT 0,
      reuse_count INTEGER NOT NULL DEFAULT 0,
      contradiction_count INTEGER NOT NULL DEFAULT 0,
      last_computed_at TEXT NOT NULL,
      FOREIGN KEY (hub_id) REFERENCES memories(id)
    );

    -- Inhibition edges: anti-memories (Novel Council: Inhibitory Memory)
    CREATE TABLE IF NOT EXISTS inhibition_edges (
      id TEXT PRIMARY KEY,
      src_id TEXT NOT NULL,
      dst_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'global',
      strength REAL NOT NULL DEFAULT 1.0,
      ttl TEXT,
      created_at TEXT NOT NULL,

      CHECK (strength >= 0.0 AND strength <= 1.0),
      CHECK (scope IN ('global', 'project', 'session')),
      FOREIGN KEY (src_id) REFERENCES memories(id),
      FOREIGN KEY (dst_id) REFERENCES memories(id)
    );

    CREATE INDEX IF NOT EXISTS idx_inhibit_dst ON inhibition_edges(dst_id);
    CREATE INDEX IF NOT EXISTS idx_inhibit_src ON inhibition_edges(src_id);

    -- Procedures table: procedural memory (Novel Council: Procedural Capsules)
    CREATE TABLE IF NOT EXISTS procedures (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      trigger_pattern TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      compliance_rate REAL NOT NULL DEFAULT 0.0,
      correction_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,

      CHECK (compliance_rate >= 0.0 AND compliance_rate <= 1.0),
      FOREIGN KEY (memory_id) REFERENCES memories(id)
    );

    CREATE INDEX IF NOT EXISTS idx_procedures_memory ON procedures(memory_id);
    CREATE INDEX IF NOT EXISTS idx_procedures_trigger ON procedures(trigger_pattern);

    -- Self-play evaluation results (Novel Council: Self-Play Evaluation)
    CREATE TABLE IF NOT EXISTS self_play_results (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      query TEXT NOT NULL,
      expected_memory_id TEXT,
      actual_memory_id TEXT,
      passed INTEGER NOT NULL DEFAULT 0,
      score_gap REAL NOT NULL DEFAULT 0,
      details TEXT,
      FOREIGN KEY (run_id) REFERENCES self_play_runs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_selfplay_run ON self_play_results(run_id);

    -- Priming cache: ephemeral per-session activation (Novel Council: Anticipatory + Priming)
    CREATE TABLE IF NOT EXISTS priming_cache (
      session_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      activation_score REAL NOT NULL DEFAULT 1.0,
      created_at TEXT NOT NULL,
      decay_rate REAL NOT NULL DEFAULT 0.1,

      PRIMARY KEY (session_id, memory_id),
      FOREIGN KEY (memory_id) REFERENCES memories(id)
    );

    CREATE INDEX IF NOT EXISTS idx_priming_session ON priming_cache(session_id);

    -- Tags (many-to-many)
    CREATE TABLE IF NOT EXISTS memory_tags (
      memory_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (memory_id, tag),
      FOREIGN KEY (memory_id) REFERENCES memories(id)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag);

    -- Hubs (fractal hub-and-spoke)
    CREATE TABLE IF NOT EXISTS memory_hubs (
      id TEXT PRIMARY KEY,
      claim TEXT NOT NULL,
      hub_type TEXT NOT NULL DEFAULT 'principle',
      created_at TEXT NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS hub_links (
      memory_id TEXT NOT NULL,
      hub_id TEXT NOT NULL,
      linked_at TEXT NOT NULL,
      PRIMARY KEY (memory_id, hub_id),
      FOREIGN KEY (memory_id) REFERENCES memories(id),
      FOREIGN KEY (hub_id) REFERENCES memory_hubs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_hub_links_hub ON hub_links(hub_id);

    -- Memory versions
    CREATE TABLE IF NOT EXISTS memory_versions (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      claim TEXT NOT NULL,
      changed_at TEXT NOT NULL,
      reason TEXT NOT NULL,
      FOREIGN KEY (memory_id) REFERENCES memories(id)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_versions_memory ON memory_versions(memory_id);

    -- Constraints
    CREATE TABLE IF NOT EXISTS memory_constraints (
      id TEXT PRIMARY KEY,
      claim TEXT NOT NULL,
      constraint_type TEXT NOT NULL DEFAULT 'hard',
      priority INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    -- Self-play runs
    CREATE TABLE IF NOT EXISTS self_play_runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      queries_generated INTEGER NOT NULL DEFAULT 0,
      retrievals_passed INTEGER NOT NULL DEFAULT 0,
      retrievals_failed INTEGER NOT NULL DEFAULT 0,
      notes TEXT
    );
    -- ============================================================
    -- R11: Fact Facets (annotation layer for episodes/state packs)
    -- ============================================================
    CREATE TABLE IF NOT EXISTS fact_facets (
      fact_id TEXT PRIMARY KEY,
      primary_subject TEXT NOT NULL,
      mentioned_subjects TEXT,
      fact_kind TEXT NOT NULL,
      topic_key TEXT,
      slot_group TEXT,
      slot_key TEXT,
      event_time TEXT,
      turn_span_start INTEGER,
      turn_span_end INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_facets_subject ON fact_facets(primary_subject);
    CREATE INDEX IF NOT EXISTS idx_facets_topic ON fact_facets(topic_key);
    CREATE INDEX IF NOT EXISTS idx_facets_kind ON fact_facets(fact_kind);
    CREATE INDEX IF NOT EXISTS idx_facets_slot ON fact_facets(slot_group, slot_key);

    -- R11: Episodes
    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      timeframe_start TEXT,
      timeframe_end TEXT,
      session_source TEXT,
      fact_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_episodes_subject ON episodes(subject);
    CREATE INDEX IF NOT EXISTS idx_episodes_timeframe ON episodes(timeframe_start);

    CREATE TABLE IF NOT EXISTS episode_facts (
      episode_id TEXT NOT NULL REFERENCES episodes(id),
      fact_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (episode_id, fact_id)
    );
    CREATE INDEX IF NOT EXISTS idx_episode_facts_fact ON episode_facts(fact_id);

    -- R11: State Packs
    CREATE TABLE IF NOT EXISTS state_packs (
      id TEXT PRIMARY KEY,
      subject TEXT UNIQUE NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      version INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS state_pack_slots (
      id TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL REFERENCES state_packs(id),
      slot_type TEXT NOT NULL,
      slot_key TEXT NOT NULL,
      slot_value TEXT NOT NULL,
      is_stale INTEGER DEFAULT 0,
      is_conflicted INTEGER DEFAULT 0,
      source_fact_id TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_slots_pack ON state_pack_slots(pack_id);
    CREATE INDEX IF NOT EXISTS idx_slots_type ON state_pack_slots(slot_type);
    CREATE INDEX IF NOT EXISTS idx_slots_stale ON state_pack_slots(is_stale);

    -- R11: Summaries
    CREATE TABLE IF NOT EXISTS summaries (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      topic TEXT NOT NULL,
      granularity TEXT NOT NULL,
      time_period_start TEXT,
      time_period_end TEXT,
      summary_text TEXT NOT NULL,
      source_episode_ids TEXT,
      fact_count INTEGER NOT NULL,
      version INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_summaries_subject ON summaries(subject, topic);

    -- R11: Bridge Facts
    CREATE TABLE IF NOT EXISTS bridge_facts (
      id TEXT PRIMARY KEY,
      subject_a TEXT NOT NULL,
      subject_b TEXT NOT NULL,
      fact_id TEXT NOT NULL,
      episode_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bridge_pair ON bridge_facts(subject_a, subject_b);

    -- ============================================================
    -- V2 Phase 1a: Claims Graph (council R17)
    -- Tables: entities, entity_aliases, claims, claim_links, current_fact_cache
    -- Feature flag: CLAIMS_GRAPH_ENABLED (default false, checked in write/read paths)
    -- Safe to migrate: write/read code does not touch these tables until Phase 1b+.
    -- Baseline guard: 62.8 LOCOMO must not regress. If it does, the DOWN migration
    -- in migrations-v2-down.sql restores the pre-V2 schema.
    -- ============================================================

    -- Canonical entity record (one row per resolved entity)
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      canonical_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      entity_type TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_canonical_key ON entities(canonical_key);
    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type) WHERE entity_type IS NOT NULL;

    -- Entity aliases: surface form → canonical entity (many-to-one)
    CREATE TABLE IF NOT EXISTS entity_aliases (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      alias_normalized TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'extraction',
      confidence REAL NOT NULL DEFAULT 1.0,
      created_at TEXT NOT NULL,

      CHECK (confidence >= 0.0 AND confidence <= 1.0),
      CHECK (source IN ('extraction', 'user-confirmed', 'inferred', 'imported')),
      FOREIGN KEY (entity_id) REFERENCES entities(id)
    );
    CREATE INDEX IF NOT EXISTS idx_aliases_entity ON entity_aliases(entity_id);
    CREATE INDEX IF NOT EXISTS idx_aliases_lookup ON entity_aliases(alias_normalized);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_aliases_normalized_unique
      ON entity_aliases(alias_normalized, entity_id);

    -- Claims: the edge. subject-predicate-object with temporal anchor.
    -- claim_type:
    --   event    , something happened (Alice moved to Seattle in March)
    --   state    , durable attribute (Alice lives in Seattle, valid_from=March)
    --   attribute, intrinsic property (Alice has blue eyes)
    --   opinion  , subjective view (Alice thinks Bob is funny)
    -- temporal_anchor_kind ladder (spec §Claims-as-edges):
    --   exact            , fully resolved timestamp
    --   relative_resolved, "last March" normalized against utterance time
    --   event_relative   , "after they met" anchored to another claim
    --   utterance        , inferred from when the statement was made
    --   unknown          , no temporal signal
    CREATE TABLE IF NOT EXISTS claims (
      id TEXT PRIMARY KEY,
      claim_type TEXT NOT NULL,
      predicate TEXT NOT NULL,
      subject_entity_id TEXT NOT NULL,
      object_entity_id TEXT,
      object_literal TEXT,

      valid_from TEXT,
      valid_to TEXT,
      asserted_at TEXT,
      temporal_anchor_kind TEXT NOT NULL DEFAULT 'unknown',

      confidence REAL NOT NULL DEFAULT 1.0,
      trust_class TEXT NOT NULL DEFAULT 'auto-approved',
      source_memory_id TEXT,
      source_hash TEXT NOT NULL,

      supersedes_claim_id TEXT,
      deleted_at TEXT,

      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,

      CHECK (claim_type IN ('event', 'state', 'attribute', 'opinion')),
      CHECK (temporal_anchor_kind IN ('exact', 'relative_resolved', 'event_relative', 'utterance', 'unknown')),
      CHECK (confidence >= 0.0 AND confidence <= 1.0),
      CHECK (trust_class IN ('confirmed', 'auto-approved', 'quarantined', 'rejected')),
      CHECK (object_entity_id IS NOT NULL OR object_literal IS NOT NULL),
      FOREIGN KEY (subject_entity_id) REFERENCES entities(id),
      FOREIGN KEY (object_entity_id) REFERENCES entities(id),
      FOREIGN KEY (supersedes_claim_id) REFERENCES claims(id),
      FOREIGN KEY (source_memory_id) REFERENCES memories(id)
    );

    -- Indexes per spec (SPO, subject+predicate+time, object+predicate)
    CREATE INDEX IF NOT EXISTS idx_claims_spo
      ON claims(subject_entity_id, predicate, object_entity_id)
      WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_claims_subject_predicate_time
      ON claims(subject_entity_id, predicate, valid_from DESC)
      WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_claims_object_predicate
      ON claims(object_entity_id, predicate)
      WHERE object_entity_id IS NOT NULL AND deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_claims_type
      ON claims(claim_type) WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_claims_predicate_type
      ON claims(predicate, claim_type) WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_claims_source_memory
      ON claims(source_memory_id)
      WHERE source_memory_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_claims_supersedes
      ON claims(supersedes_claim_id)
      WHERE supersedes_claim_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_claims_trust_class
      ON claims(trust_class) WHERE deleted_at IS NULL;

    -- Claim links: edges between claims (derived_state, causes, contradicts, supports)
    -- Most common: event claim → derived_state claim, created at write time.
    CREATE TABLE IF NOT EXISTS claim_links (
      id TEXT PRIMARY KEY,
      src_claim_id TEXT NOT NULL,
      dst_claim_id TEXT NOT NULL,
      link_type TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      created_at TEXT NOT NULL,

      CHECK (link_type IN ('derived_state', 'causes', 'contradicts', 'supports')),
      CHECK (confidence >= 0.0 AND confidence <= 1.0),
      FOREIGN KEY (src_claim_id) REFERENCES claims(id),
      FOREIGN KEY (dst_claim_id) REFERENCES claims(id)
    );
    CREATE INDEX IF NOT EXISTS idx_claim_links_src ON claim_links(src_claim_id);
    CREATE INDEX IF NOT EXISTS idx_claim_links_dst ON claim_links(dst_claim_id);
    CREATE INDEX IF NOT EXISTS idx_claim_links_type ON claim_links(link_type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_links_unique
      ON claim_links(src_claim_id, dst_claim_id, link_type);

    -- Current-fact cache: materialized current state per (subject, predicate).
    -- Rebuilt at write time when a new state claim supersedes an older one.
    -- Fast path for lookup+current+scalar queries (spec §Current-state cache).
    CREATE TABLE IF NOT EXISTS current_fact_cache (
      subject_entity_id TEXT NOT NULL,
      predicate TEXT NOT NULL,
      claim_id TEXT NOT NULL,
      valid_from TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      updated_at TEXT NOT NULL,

      PRIMARY KEY (subject_entity_id, predicate),
      CHECK (confidence >= 0.0 AND confidence <= 1.0),
      FOREIGN KEY (subject_entity_id) REFERENCES entities(id),
      FOREIGN KEY (claim_id) REFERENCES claims(id)
    );
    CREATE INDEX IF NOT EXISTS idx_current_fact_predicate ON current_fact_cache(predicate);
    CREATE INDEX IF NOT EXISTS idx_current_fact_claim ON current_fact_cache(claim_id);

    -- Wedge 3: Materializer. Versioned extraction-policy registry plus a
    -- durable projection cache keyed by (stone_window, policy_id, asOf_minute).
    -- Schema is W3/W4 forward-compatible: adjudication_state JSON column
    -- holds the binary detectInjection decision in W3, and the calibrated
    -- model score + expanded reason_codes in W4 -- no migration needed.
    CREATE TABLE IF NOT EXISTS materialization_policies (
      policy_id       TEXT PRIMARY KEY,
      version         INTEGER NOT NULL,
      prompt_template TEXT NOT NULL,
      model_id        TEXT NOT NULL,
      params          TEXT,
      created_at      TEXT NOT NULL,
      retired_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mat_policies_active ON materialization_policies(retired_at);

    CREATE TABLE IF NOT EXISTS materializations (
      cache_key          TEXT PRIMARY KEY,
      policy_id          TEXT NOT NULL,
      stone_window_start INTEGER,
      stone_window_end   INTEGER,
      conversation_id    TEXT,
      asof_anchor        TEXT,
      assertions         TEXT NOT NULL,
      adjudication_state TEXT NOT NULL,
      cost_usd           REAL NOT NULL DEFAULT 0,
      created_at         TEXT NOT NULL,
      last_accessed_at   TEXT NOT NULL,
      hit_count          INTEGER NOT NULL DEFAULT 0,
      stale_at           TEXT,
      FOREIGN KEY (policy_id) REFERENCES materialization_policies(policy_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mat_conv ON materializations(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_mat_policy ON materializations(policy_id);
    CREATE INDEX IF NOT EXISTS idx_mat_stale ON materializations(stale_at);
    CREATE INDEX IF NOT EXISTS idx_mat_window ON materializations(conversation_id, stone_window_start, stone_window_end);
    CREATE INDEX IF NOT EXISTS idx_mat_last_accessed ON materializations(last_accessed_at);

  `);

  // Migration: add permanence_status column to existing databases
  const columns = db.pragma('table_info(memories)') as { name: string }[];
  const hasPermanence = columns.some((c) => c.name === 'permanence_status');
  if (!hasPermanence) {
    db.exec(`ALTER TABLE memories ADD COLUMN permanence_status TEXT NOT NULL DEFAULT 'provisional'`);
  }

  // Migration: Novel Council schema additions
  const hasHubId = columns.some((c) => c.name === 'hub_id');
  if (!hasHubId) {
    db.exec(`ALTER TABLE memories ADD COLUMN hub_id TEXT`);
    db.exec(`ALTER TABLE memories ADD COLUMN hub_score REAL NOT NULL DEFAULT 0.0`);
    db.exec(`ALTER TABLE memories ADD COLUMN resolution INTEGER NOT NULL DEFAULT 3`);
    db.exec(`ALTER TABLE memories ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'declarative'`);
    db.exec(`ALTER TABLE memories ADD COLUMN version_number INTEGER NOT NULL DEFAULT 1`);
    db.exec(`ALTER TABLE memories ADD COLUMN parent_version_id TEXT`);
    db.exec(`ALTER TABLE memories ADD COLUMN frozen_at TEXT`);
    db.exec(`ALTER TABLE memories ADD COLUMN decay_score REAL NOT NULL DEFAULT 1.0`);
    db.exec(`ALTER TABLE memories ADD COLUMN storage_tier TEXT NOT NULL DEFAULT 'active'`);
  }

  // Migration: Packet 2a inhibitory/interference/causal columns
  const refreshedCols = db.pragma('table_info(memories)') as { name: string }[];
  if (!refreshedCols.some((c) => c.name === 'is_inhibitory')) {
    db.exec(`ALTER TABLE memories ADD COLUMN is_inhibitory INTEGER NOT NULL DEFAULT 0`);
    db.exec(`ALTER TABLE memories ADD COLUMN inhibition_target TEXT`);
    db.exec(`ALTER TABLE memories ADD COLUMN interference_status TEXT NOT NULL DEFAULT 'active'`);
    db.exec(`ALTER TABLE memories ADD COLUMN correction_count INTEGER NOT NULL DEFAULT 0`);
    db.exec(`ALTER TABLE memories ADD COLUMN is_frozen INTEGER NOT NULL DEFAULT 0`);
    db.exec(`ALTER TABLE memories ADD COLUMN caused_by TEXT`);
    db.exec(`ALTER TABLE memories ADD COLUMN leads_to TEXT`);
  }

  // Migration: canonical fact columns (Packet 2b / STONE)
  const cols2b = db.pragma('table_info(memories)') as { name: string }[];
  if (!cols2b.some((c) => c.name === 'canonical_fact_id')) {
    db.exec(`ALTER TABLE memories ADD COLUMN canonical_fact_id TEXT`);
    db.exec(`ALTER TABLE memories ADD COLUMN is_canonical INTEGER NOT NULL DEFAULT 1`);
  }

  // Novel indexes (Packet 2a)
  const idxCheck = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`);
  if (!idxCheck.get('idx_memories_inhibitory')) {
    db.exec(
      `CREATE INDEX idx_memories_inhibitory ON memories(is_inhibitory) WHERE is_inhibitory = 1 AND deleted_at IS NULL`,
    );
    db.exec(`CREATE INDEX idx_memories_interference ON memories(interference_status) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX idx_memories_is_frozen ON memories(is_frozen) WHERE is_frozen = 1 AND deleted_at IS NULL`);
    db.exec(
      `CREATE INDEX idx_memories_caused_by ON memories(caused_by) WHERE caused_by IS NOT NULL AND deleted_at IS NULL`,
    );
    db.exec(
      `CREATE INDEX idx_memories_leads_to ON memories(leads_to) WHERE leads_to IS NOT NULL AND deleted_at IS NULL`,
    );
  }

  // Migration: recreate self_play_results if it has the old Packet 1 schema
  const spCols = db.pragma('table_info(self_play_results)') as { name: string }[];
  if (spCols.length > 0 && !spCols.some((c) => c.name === 'run_id')) {
    db.exec(`DROP TABLE IF EXISTS self_play_results`);
    db.exec(`
      CREATE TABLE self_play_results (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        query TEXT NOT NULL,
        expected_memory_id TEXT,
        actual_memory_id TEXT,
        passed INTEGER NOT NULL DEFAULT 0,
        score_gap REAL NOT NULL DEFAULT 0,
        details TEXT,
        FOREIGN KEY (run_id) REFERENCES self_play_runs(id)
      )
    `);
    db.exec(`CREATE INDEX idx_selfplay_run ON self_play_results(run_id)`);
  }

  // ============================================================
  // Packet 0: User-scoped requests
  // Add user_id partition column + indexes to top-level row tables.
  // Existing rows backfill to 'system' via DEFAULT during ALTER.
  // V2 graph tables (claims, entities, claim_links, current_fact_cache,
  // entity_aliases) are intentionally not scoped here, they are
  // feature-flag OFF in production. Defer to a later packet.
  // state_packs UNIQUE(subject) is preserved (state_packs are flag-OFF;
  // single-tenant invariant holds). Composite UNIQUE(user_id, subject)
  // lands when per-user state packs ship.
  // ============================================================
  for (const table of ['memories', 'audit_log', 'episodes', 'state_packs', 'summaries']) {
    const tcols = db.pragma(`table_info(${table})`) as { name: string }[];
    if (tcols.length === 0) continue; // table doesn't exist yet (shouldn't happen, runs after CREATE TABLE block)
    if (!tcols.some((c) => c.name === 'user_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT NOT NULL DEFAULT 'system'`);
    }
  }

  // External_ref idempotency column for memories (caller-controlled dedup).
  const memCols = db.pragma('table_info(memories)') as { name: string }[];
  if (!memCols.some((c) => c.name === 'external_ref')) {
    db.exec(`ALTER TABLE memories ADD COLUMN external_ref TEXT`);
  }

  // User-scoped indexes (idempotent).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_user
      ON memories(user_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_memories_user_subject
      ON memories(user_id, subject) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_memories_user_review
      ON memories(user_id, review_status) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_audit_user
      ON audit_log(user_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_episodes_user
      ON episodes(user_id, subject);
    CREATE INDEX IF NOT EXISTS idx_summaries_user
      ON summaries(user_id, subject, topic);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_user_external_ref
      ON memories(user_id, external_ref) WHERE external_ref IS NOT NULL;
  `);

  // Migration: Packet A bi-temporal columns + entity_index denormalized table.
  // Idempotent. Safe to re-run on existing databases.
  const colsPacketA = db.pragma('table_info(memories)') as { name: string }[];
  if (!colsPacketA.some((c) => c.name === 'valid_at')) {
    db.exec(`ALTER TABLE memories ADD COLUMN valid_at TEXT`);
    db.exec(`ALTER TABLE memories ADD COLUMN invalid_at TEXT`);
    db.exec(`UPDATE memories SET valid_at = created_at WHERE valid_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_invalid_at ON memories(invalid_at)`);
  }

  // Packet C3 / Bug 3: persona flag for skin-persona retrieval boost.
  // Idempotent. Safe to re-run on existing databases.
  const colsPacketC3 = db.pragma('table_info(memories)') as { name: string }[];
  if (!colsPacketC3.some((c) => c.name === 'persona')) {
    db.exec(`ALTER TABLE memories ADD COLUMN persona INTEGER NOT NULL DEFAULT 0`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_memories_user_persona ON memories(user_id, persona) WHERE persona = 1 AND deleted_at IS NULL`,
    );
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_index (
      entity_text TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      user_id TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL,
      PRIMARY KEY (entity_text, memory_id),
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_index_text ON entity_index(entity_text, user_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_index_memory ON entity_index(memory_id)`);

  // S59 / TEMPR: nullable session_id + episode_id columns on memories for direct
  // pre-rerank filter speed at retrieval time. Distinct from the normalized
  // episodes / episode_facts tables, those are write-side structure; these are
  // read-side speed. Populated by writers that have session context (DialSim);
  // production users will leave NULL and the filter degrades gracefully.
  const colsTempr = db.pragma('table_info(memories)') as { name: string }[];
  if (!colsTempr.some((c) => c.name === 'session_id')) {
    db.exec(`ALTER TABLE memories ADD COLUMN session_id TEXT`);
  }
  if (!colsTempr.some((c) => c.name === 'episode_id')) {
    db.exec(`ALTER TABLE memories ADD COLUMN episode_id TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id) WHERE session_id IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_episode ON memories(episode_id) WHERE episode_id IS NOT NULL`);

  // D1 + A7 (S72): additive-only audit columns for write-time temporal resolution.
  // raw_claim preserves the original phrasing when the resolver mutates a claim;
  // normalization stores the audit JSON. Both NULL when no mutation happened
  // (the common case). See src/inject/temporal-parse-ir.ts.
  const colsTemporal = db.pragma('table_info(memories)') as { name: string }[];
  if (!colsTemporal.some((c) => c.name === 'raw_claim')) {
    db.exec(`ALTER TABLE memories ADD COLUMN raw_claim TEXT`);
  }
  if (!colsTemporal.some((c) => c.name === 'normalization')) {
    db.exec(`ALTER TABLE memories ADD COLUMN normalization TEXT`);
  }

  // Wedge 2 (S74): assertion_triples, typed (subject, predicate, object)
  // index over assertions, populated at write time by the hybrid decomposer
  // in src/plan/triples.ts. The plan executor's lookup operator reads from
  // idx_triple_sp / idx_triple_op. The CHECK enforces that every row has
  // either a parsed predicate or a fallback object_literal (the decomposer
  // emits a fallback row when no grammar pattern matches). conflict_set_id
  // is the lexicographically-lowest assertion_id in the conflict cluster,
  // so idx_triple_conflict turns "list every triple in this cluster" into
  // an O(log n) equality lookup. See docs/internal/WEDGE_2_PACKET.md §3.
  db.exec(`
    CREATE TABLE IF NOT EXISTS assertion_triples (
      assertion_id    TEXT NOT NULL,
      subject         TEXT NOT NULL,
      predicate       TEXT,
      object          TEXT,
      object_literal  TEXT,
      valid_from      TEXT,
      valid_to        TEXT,
      confidence      REAL,
      conflict_set_id TEXT,
      created_at      TEXT NOT NULL,
      FOREIGN KEY (assertion_id) REFERENCES memories(id) ON DELETE CASCADE,
      CHECK (predicate IS NOT NULL OR object_literal IS NOT NULL),
      CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0))
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_triple_sp        ON assertion_triples(subject, predicate)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_triple_op        ON assertion_triples(object, predicate)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_triple_conflict  ON assertion_triples(conflict_set_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_triple_subject   ON assertion_triples(subject)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_triple_assertion ON assertion_triples(assertion_id)`);

  // ============================================================
  // R29 WB-1: integrity epoch + per-user chain head (F-D6-1 / F-D6-3,
  // R29-N7 / R29-N8). One migration, idempotent, safe on both a fresh DB
  // and an already-populated (legacy) one.
  //
  // chain_head is the authoritative per-user audit head. The write path
  // (insertWithAudit / appendAuditLog) reads and updates it under a
  // compare-and-set inside an IMMEDIATE transaction, so two concurrent
  // writers cannot fork a user's chain (R29-N8). It is left empty here on
  // purpose: post-epoch chains start fresh per user (previousHash = null on
  // the first write), which is exactly what the epoch-aware verifier expects.
  //
  // On an already-populated DB we also write a ONE-TIME signed, audited
  // epoch marker (R29-N7). The marker is itself a hash-chained audit_log row
  // whose previousHash is the legacy global head, so the boundary between
  // the legacy era and the per-user era cannot be forged or relabeled
  // without breaking the chain. A fresh/empty DB has no legacy chain, so no
  // marker is written and the plain per-user verifier path is used unchanged
  // (this also keeps the existing fresh-DB tests' entry counts intact).
  // ============================================================
  runChainEpochMigration(db);
}

/**
 * R29 WB-1 helper. Extracted so the logic is unit-testable and the
 * idempotency guards stay legible. See the block in runMigrations for the
 * design rationale.
 */
export function runChainEpochMigration(db: Database.Database): void {
  const nowIso = new Date().toISOString();

  db.exec(`
    CREATE TABLE IF NOT EXISTS chain_head (
      user_id    TEXT PRIMARY KEY,
      last_hash  TEXT,
      updated_at TEXT NOT NULL
    );
  `);

  // Deletion tombstone manifest (R29-N7). When audit rows are intentionally
  // removed (a user delete, or the one-time pre-epoch legacy wipe per ruling
  // 2), the head hash of the removed segment is recorded here. The verifier
  // tolerates a dangling previousHash ONLY when it is covered by one of these
  // rows, so an intentional deletion reads as a deletion and a tamper that
  // removes rows without a manifest entry still reads as a break.
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_tombstones (
      id                   TEXT PRIMARY KEY,
      user_id              TEXT NOT NULL,
      deleted_through_hash TEXT,
      reason               TEXT NOT NULL,
      operator             TEXT,
      created_at           TEXT NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_tombstones_hash ON audit_tombstones(deleted_through_hash)`);

  // Stamp the schema version (upsert so a re-run reflects the current value).
  db.prepare(
    `INSERT INTO system_metadata (key, value, updated_at)
     VALUES ('schema_version', @value, @updatedAt)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run({ value: SCHEMA_VERSION, updatedAt: nowIso });

  const legacyCount = (db.prepare(`SELECT COUNT(*) AS c FROM audit_log`).get() as { c: number }).c;
  const epochCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE action = ?`).get(AUDIT_EPOCH_ACTION) as { c: number }
  ).c;

  // Only mark an epoch on a populated DB that has not already been marked.
  // A fresh DB (legacyCount === 0) gets no marker. A re-run (epochCount > 0)
  // is a no-op.
  if (legacyCount === 0 || epochCount > 0) return;

  const headRow = db.prepare(`SELECT hash FROM audit_log ORDER BY rowid DESC LIMIT 1`).get() as
    | { hash: string }
    | undefined;
  const rangeRow = db.prepare(`SELECT MIN(rowid) AS lo, MAX(rowid) AS hi FROM audit_log`).get() as {
    lo: number;
    hi: number;
  };
  const perUserHeads = db
    .prepare(
      `SELECT user_id AS userId, hash FROM audit_log a
       WHERE a.rowid = (SELECT MAX(b.rowid) FROM audit_log b WHERE b.user_id IS a.user_id)`,
    )
    .all() as { userId: string | null; hash: string }[];

  const legacyGlobalHead = headRow?.hash ?? null;
  const details = JSON.stringify({
    kind: 'chain-epoch',
    schemaVersion: SCHEMA_VERSION,
    migrationCode: EPOCH_MIGRATION_CODE,
    legacyRowidRange: [rangeRow.lo, rangeRow.hi],
    legacyGlobalHead,
    perUserPreEpochHeads: Object.fromEntries(perUserHeads.map((r) => [r.userId ?? 'system', r.hash])),
    operator: process.env.DEMIURGE_OPERATOR ?? 'migration',
    timestamp: nowIso,
  });

  // The marker continues (and terminates) the legacy global chain: its
  // previousHash is the legacy global head. Recomputing this hash and
  // confirming previousHash === legacyGlobalHead is how the verifier proves
  // the boundary was not forged.
  const id = randomUUID();
  const core = { memoryId: null, action: AUDIT_EPOCH_ACTION, details, timestamp: nowIso };
  const hash = computeEntryHash(core, legacyGlobalHead);

  db.prepare(
    `INSERT INTO audit_log (id, user_id, memory_id, action, details, previous_hash, hash, timestamp)
     VALUES (@id, 'system', NULL, @action, @details, @previousHash, @hash, @timestamp)`,
  ).run({ id, action: AUDIT_EPOCH_ACTION, details, previousHash: legacyGlobalHead, hash, timestamp: nowIso });
}

/**
 * Initialize sqlite-vec virtual table.
 * Called separately because sqlite-vec must be loaded as an extension first.
 */
export function initializeVectorTable(db: Database.Database, embeddingDim: number = 384): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[${embeddingDim}]
    );
  `);

  // R11: Episode and Summary vector tables
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS episode_vec USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[${embeddingDim}]
    );
  `);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS summary_vec USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[${embeddingDim}]
    );
  `);

  // R12: Binary quantized vec tables (pre-filter seam for future optimization)
  // Binary vectors: 384-dim = 48 bytes vs 1536 bytes for float32 (32x smaller)
  // Hamming distance search is ~10x faster at 5K vectors.
  // Current use: dual-write only. Binary search activates at 50K+ scale.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec_bit USING vec0(
      id TEXT PRIMARY KEY,
      embedding bit[${embeddingDim}]
    );
  `);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS episode_vec_bit USING vec0(
      id TEXT PRIMARY KEY,
      embedding bit[${embeddingDim}]
    );
  `);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS summary_vec_bit USING vec0(
      id TEXT PRIMARY KEY,
      embedding bit[${embeddingDim}]
    );
  `);
}
