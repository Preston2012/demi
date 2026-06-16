-- ============================================================
-- DOWN migration for V2 Phase 1a (Claims Graph)
-- Date: 2026-04-15
-- Source: demiurge_v2_compositional_planner_spec.md v1.0
--
-- Reverses the additions in migrations.ts (V2 Phase 1a block).
-- Safe to run: drops only the 5 new tables. Indexes drop with their tables.
-- Memories, audit_log, memories_fts, memories_vec, and every other table
-- from R1–R12 are untouched.
--
-- Preconditions before running:
--   1. No code path reads from or writes to any of these 5 tables.
--   2. CLAIMS_GRAPH_ENABLED is unset or false in .env.
--   3. Backup taken: cp demiurge.db demiurge.db.pre-down-v2a
--
-- Apply:
--   sqlite3 /root/demiurge/data/demiurge.db < migrations-v2-down.sql
-- ============================================================

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

DROP TABLE IF EXISTS current_fact_cache;
DROP TABLE IF EXISTS claim_links;
DROP TABLE IF EXISTS claims;
DROP TABLE IF EXISTS entity_aliases;
DROP TABLE IF EXISTS entities;

COMMIT;

PRAGMA foreign_keys = ON;

-- Verification after running:
--   SELECT name FROM sqlite_master WHERE type='table'
--     AND name IN ('entities','entity_aliases','claims','claim_links','current_fact_cache');
--   Expected: 0 rows.
