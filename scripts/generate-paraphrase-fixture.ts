#!/usr/bin/env npx tsx
/**
 * One-shot script to materialize the deterministic paraphrase fixture into
 * fixtures/benchmark/product/paraphrase/{mini,full}.json.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate } from '../src/benchmark/product/paraphrase/generator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function main(): void {
  const seed = 42;
  for (const mode of ['mini', 'full'] as const) {
    const fixture = generate(seed, mode);
    const outDir = resolve(__dirname, '..', 'fixtures', 'benchmark', 'product', 'paraphrase');
    mkdirSync(outDir, { recursive: true });
    const outPath = resolve(outDir, `${mode}.json`);
    writeFileSync(outPath, JSON.stringify(fixture, null, 2));
    const totalQ = fixture.scenarios.reduce((a, s) => a + s.queries.length, 0);
    console.log(`Wrote ${outPath}: ${fixture.scenarios.length} clusters, ${totalQ} questions`);
  }
}

main();
