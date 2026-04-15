import type Database from 'better-sqlite3';

/**
 * All DDL lives here. Run once at boot via initialize().
 * Order matters. Tables before indexes before FTS before vec.
 *
 * sqlite-vec virtual table uses float[${embeddingDim}] for BGE-large embeddings.
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
}

/**
 * Initialize sqlite-vec virtual table.
 * Called separately because sqlite-vec must be loaded as an extension first.
 */
export function initializeVectorTable(db: Database.Database, embeddingDim: number = 1024): void {
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
  // Binary vectors: 1024-dim = 128 bytes vs 4096 bytes for float32 (32x smaller)
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
