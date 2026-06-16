/**
 * Bench 2 (Cross-Session Temporal), fixture loader (S68 v2).
 *
 * Loads the committed scenarios JSON. The fixture is baked offline by
 * `bake.ts`, which uses BGE-small embeddings to enforce pairwise cosine
 * distinctness < 0.92 (vs engine dedup threshold 0.95, giving 0.03 margin).
 *
 * v1 used in-line random sampling without distinctness checks; many synthetic
 * facts collided at cosine ≥0.95 and the bench had to skip dedup. See
 * `bake.ts` header for the full rewrite rationale.
 *
 * If the fixture file is missing, the runner instructs the operator to run
 * `npx tsx src/benchmark/cross-session-temporal/bake.ts --mode <mode>`.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

import type {
  CSTFixture,
  CSTQuestion,
  CSTQuestionType,
  Fact,
  Session,
  FixtureManifest,
  Theme,
} from './generator-types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type { CSTFixture, CSTQuestion, CSTQuestionType, Fact, Session, FixtureManifest, Theme };

/**
 * Load the baked fixture for a given mode. Pure synchronous file read; no
 * BGE init needed at this point because the fixture was already pairwise-
 * verified at bake time.
 *
 * The runner's optional `verifyFixturePairwise()` (below) re-checks against
 * the current BGE model on load, call it once per session to catch model
 * drift.
 */
export function generate(seed: number, mode: 'mini' | 'full'): CSTFixture {
  const fixturePath = resolve(__dirname, 'fixtures', `scenarios-${mode}.json`);
  if (!existsSync(fixturePath)) {
    throw new Error(
      `Cross-session-temporal fixture missing: ${fixturePath}\n` +
        `Run: npx tsx src/benchmark/cross-session-temporal/bake.ts --mode ${mode}`,
    );
  }
  const raw = readFileSync(fixturePath, 'utf-8');
  const fixture = JSON.parse(raw) as CSTFixture;
  if (fixture.seed !== seed) {
    console.warn(
      `[cross-session-temporal] WARN fixture seed=${fixture.seed} but runner seed=${seed}. ` +
        `The runner uses the committed fixture's seed. Re-bake if you need a different seed.`,
    );
  }
  return fixture;
}

/**
 * Optional runtime sanity probe. Re-embeds every fact in the fixture against
 * the current BGE model and verifies pairwise cosine still < threshold.
 * Catches the case where someone bumps the embedding model but forgets to
 * re-bake. Aborts the bench if drift exceeds the engine dedup threshold (0.95).
 *
 * Cost: ~3-10s for a 350-fact fixture; intended to be called once at runner
 * startup (before bench loop), not per question.
 */
export async function verifyFixturePairwise(
  fixture: CSTFixture,
  encode: (text: string) => Promise<number[]>,
  cosineSimilarity: (a: number[], b: number[]) => number,
  abortAtCosine = 0.95,
): Promise<{ maxObserved: number; warnings: string[] }> {
  const allFacts: Fact[] = fixture.sessions.flatMap((s) => s.facts);
  const embeddings: number[][] = [];
  for (const f of allFacts) {
    embeddings.push(await encode(f.claim));
  }
  let maxObserved = 0;
  const warnings: string[] = [];
  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      const sim = cosineSimilarity(embeddings[i]!, embeddings[j]!);
      if (sim > maxObserved) maxObserved = sim;
      if (sim >= abortAtCosine) {
        const fi = allFacts[i]!;
        const fj = allFacts[j]!;
        warnings.push(`pair-cosine ${sim.toFixed(4)} >= ${abortAtCosine}: "${fi.claim}" vs "${fj.claim}"`);
      }
    }
  }
  if (warnings.length > 0) {
    throw new Error(
      `Fixture pairwise drift detected. ${warnings.length} pair(s) above threshold ${abortAtCosine}:\n` +
        warnings.slice(0, 5).join('\n') +
        (warnings.length > 5 ? `\n... and ${warnings.length - 5} more` : '') +
        `\nRe-bake fixture: npx tsx src/benchmark/cross-session-temporal/bake.ts --mode ${fixture.mode}`,
    );
  }
  return { maxObserved, warnings };
}
