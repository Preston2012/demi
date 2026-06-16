#!/usr/bin/env tsx
/**
 * S50: One-shot migration from a plaintext SQLite DB to a SQLCipher-encrypted DB.
 *
 * Use case: an existing dev/staging Demiurge install built before S50 has a
 * `data/demiurge.db` written by `better-sqlite3` with no encryption. To move
 * to encryption-at-rest without losing the brain, run:
 *
 *   npx tsx scripts/migrate-to-sqlcipher.ts \
 *     --src ./data/demiurge.db \
 *     --dst ./data/demiurge.enc.db \
 *     --key $(openssl rand -hex 32)
 *
 * Then update DB_PATH and DEMIURGE_DB_KEY in your .env. The original
 * plaintext file is left in place, verify the new file works, then delete
 * the plaintext copy yourself (this script does NOT auto-delete).
 *
 * Mechanism: ATTACH the destination as encrypted, then iterate every user
 * table from sqlite_master and `INSERT INTO encrypted.X SELECT * FROM main.X`.
 * Schema (CREATE TABLE/INDEX/TRIGGER/VIEW) is copied first via the captured
 * `sql` column. Virtual tables (sqlite-vec, FTS5) require their owning module
 * to be loaded; the engine recreates them on first boot, so we skip them here.
 */

import Database from 'better-sqlite3-multiple-ciphers';
import { existsSync, statSync } from 'node:fs';

interface Args {
  src: string;
  dst: string;
  key: string;
}

interface SqliteMasterRow {
  type: 'table' | 'index' | 'trigger' | 'view';
  name: string;
  tbl_name: string;
  sql: string | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = argv[i + 1];
    if (flag === '--src') {
      out.src = val;
      i++;
    } else if (flag === '--dst') {
      out.dst = val;
      i++;
    } else if (flag === '--key') {
      out.key = val;
      i++;
    } else if (flag === '--help' || flag === '-h') {
      printUsage();
      process.exit(0);
    }
  }
  if (!out.src || !out.dst || !out.key) {
    console.error('Missing required argument.');
    printUsage();
    process.exit(2);
  }
  return out as Args;
}

function printUsage(): void {
  console.error('Usage: tsx scripts/migrate-to-sqlcipher.ts --src <plaintext.db> --dst <encrypted.db> --key <64-hex>');
}

// Skip virtual tables, they're rebuilt by the engine on first boot from
// canonical state and depend on extension modules (sqlite-vec, FTS5) that
// aren't loaded into this script's connection.
function isVirtualTableSql(sql: string | null): boolean {
  if (!sql) return false;
  return /CREATE\s+VIRTUAL\s+TABLE/i.test(sql);
}

function main(): void {
  const args = parseArgs();

  if (!existsSync(args.src)) {
    console.error(`Source database does not exist: ${args.src}`);
    process.exit(1);
  }
  if (existsSync(args.dst)) {
    console.error(`Destination already exists, refusing to overwrite: ${args.dst}`);
    console.error('Delete it first if you intend to re-migrate.');
    process.exit(1);
  }
  if (!/^[0-9a-f]{64}$/i.test(args.key)) {
    console.error('--key must be 64 hex chars (32 bytes). Generate with: openssl rand -hex 32');
    process.exit(1);
  }

  const srcSize = statSync(args.src).size;
  console.log(`Source:      ${args.src} (${srcSize} bytes)`);
  console.log(`Destination: ${args.dst}`);
  console.log(`Key:         ${args.key.slice(0, 8)}...${args.key.slice(-4)} (32 bytes)`);
  console.log('');

  const db = new Database(args.src);
  try {
    // ATTACH the destination as an encrypted DB. Anything written via
    // `encrypted.X` lands in the new file under SQLCipher v4 format.
    db.exec(`ATTACH DATABASE '${args.dst.replace(/'/g, "''")}' AS encrypted KEY "x'${args.key}'"`);
    db.exec(`PRAGMA encrypted.cipher_compatibility = 4`);

    const objects = db
      .prepare(
        `SELECT type, name, tbl_name, sql
         FROM main.sqlite_master
         WHERE name NOT LIKE 'sqlite_%'
         ORDER BY CASE type
           WHEN 'table' THEN 1
           WHEN 'index' THEN 2
           WHEN 'view'  THEN 3
           WHEN 'trigger' THEN 4
           ELSE 5 END`,
      )
      .all() as SqliteMasterRow[];

    let tablesCopied = 0;
    let tablesSkipped = 0;

    db.exec('BEGIN');
    try {
      // Pass 1: CREATE everything in the destination (tables first, then indices, etc.)
      for (const obj of objects) {
        if (!obj.sql) continue;
        if (isVirtualTableSql(obj.sql)) {
          tablesSkipped++;
          console.log(`  skip virtual: ${obj.name}`);
          continue;
        }
        // Rewrite "CREATE TABLE foo" → "CREATE TABLE encrypted.foo" via attached-DB execution.
        // Easier: exec on encrypted by prefixing nothing, better-sqlite3-multiple-ciphers
        // executes against the attached DB when we run inside the connection. We need
        // to rewrite the qualifier. Simplest: run the literal SQL but in a context that
        // creates in the encrypted DB. We do that by `INSERT INTO encrypted.X` for data
        // and direct CREATE in encrypted via main-prefixed DDL.
        const ddl = obj.sql.replace(
          /^(\s*CREATE\s+(?:UNIQUE\s+)?(?:TEMP\s+|TEMPORARY\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?)("?)/i,
          (_match, head: string, q: string) => `${head}encrypted.${q}`,
        );
        db.exec(ddl);
      }

      // Pass 2: Copy data for every real table.
      for (const obj of objects) {
        if (obj.type !== 'table') continue;
        if (isVirtualTableSql(obj.sql)) continue;
        // sqlite-internal bookkeeping: skip
        if (obj.name.startsWith('sqlite_')) continue;
        db.exec(`INSERT INTO encrypted."${obj.name}" SELECT * FROM main."${obj.name}"`);
        tablesCopied++;
      }

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    db.exec(`DETACH DATABASE encrypted`);

    console.log('');
    console.log(`Tables copied:  ${tablesCopied}`);
    console.log(`Tables skipped: ${tablesSkipped} (virtual; engine will rebuild on next boot)`);
  } finally {
    db.close();
  }

  // Verify: reopen with key, count rows.
  const verify = new Database(args.dst);
  try {
    verify.pragma(`key = "x'${args.key}'"`);
    verify.pragma('cipher_compatibility = 4');
    const tables = verify
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as { name: string }[];
    console.log('');
    console.log(`Verified tables in destination (${tables.length}):`);
    for (const t of tables) {
      const row = verify.prepare(`SELECT COUNT(*) as n FROM "${t.name}"`).get() as { n: number };
      console.log(`  ${t.name}: ${row.n} rows`);
    }
  } finally {
    verify.close();
  }

  const dstSize = statSync(args.dst).size;
  console.log('');
  console.log(`Migration complete. ${args.dst} (${dstSize} bytes)`);
  console.log('Next steps:');
  console.log(`  1. Update DB_PATH in .env to: ${args.dst}`);
  console.log(`  2. Set DEMIURGE_DB_KEY in .env to your hex key`);
  console.log(`  3. Smoke-test the engine, then delete the plaintext source: ${args.src}`);
}

main();
