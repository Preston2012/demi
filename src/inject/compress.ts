/**
 * Injection-side fact dedup. Removes near-duplicate claims using Jaccard
 * similarity. NEVER merges, keeps the higher-scored copy.
 */

import type { CompiledMemory } from '../schema/memory.js';

function wordSet(claim: string): Set<string> {
  return new Set(
    claim
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(function (w) {
        return w.length > 1;
      }),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  // S67: iterate Set directly. With FACT_DEDUP=true on a 65-candidate
  // payload, this fires ~2080 times per retrieval (n*(n-1)/2). Allocating
  // an Array per call adds GC pressure; for...of on a Set is allocation-free.
  let intersection = 0;
  for (const x of a) {
    if (b.has(x)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// S69: FACT_DEDUP hardcoded ON. FACT_DEDUP=false killed -2.4pp LOCOMO (brain #498).
export function dedupFacts(memories: CompiledMemory[]): CompiledMemory[] {
  const threshold = parseFloat(process.env.DEDUP_SIMILARITY || '0.82');
  const wordSets = memories.map(function (m) {
    return wordSet(m.claim);
  });
  const killed = new Set<number>();

  for (let i = 0; i < memories.length; i++) {
    if (killed.has(i)) continue;
    for (let j = i + 1; j < memories.length; j++) {
      if (killed.has(j)) continue;
      const sim = jaccard(wordSets[i]!, wordSets[j]!);
      if (sim >= threshold) {
        if (memories[i]!.score >= memories[j]!.score) {
          killed.add(j);
        } else {
          killed.add(i);
          break;
        }
      }
    }
  }

  return memories.filter(function (_, idx) {
    return !killed.has(idx);
  });
}
