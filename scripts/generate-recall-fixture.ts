#!/usr/bin/env npx tsx
/**
 * One-shot Recall@K fixture materializer.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRecallFixture } from '../src/benchmark/calibration/recall/build-fixture.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function main(): void {
  const seed = 42;
  for (const mode of ['mini', 'full'] as const) {
    const fixture = buildRecallFixture(seed, mode);
    const outDir = resolve(__dirname, '..', 'fixtures', 'benchmark', 'calibration', 'recall');
    mkdirSync(outDir, { recursive: true });
    const outPath = resolve(outDir, `${mode}.json`);
    writeFileSync(outPath, JSON.stringify(fixture, null, 2));
    const totalMems = fixture.clusters.reduce((a, c) => a + c.memories.length, 0);
    const totalRel = fixture.clusters.reduce((a, c) => a + c.memories.filter((m) => m.relevant).length, 0);
    console.log(
      `Wrote ${outPath}: ${fixture.clusters.length} clusters, ${totalMems} memories (${totalRel} labeled relevant)`,
    );
  }
}

main();
