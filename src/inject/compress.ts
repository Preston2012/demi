/**
 * Subject-grouped fact compression for injection.
 *
 * Groups facts by subject, merges claims for subjects with many facts.
 * Reduces token count and [M] tag noise for the answer model.
 *
 * Algorithm:
 *   1. Group memories by subject
 *   2. For groups with < COMPRESS_THRESHOLD facts: leave as-is
 *   3. For groups with >= threshold: merge into composite claims
 *      - Sort by createdAt (chronological)
 *      - Join with "; " separator
 *      - Keep highest-scoring fact's metadata for the composite
 *
 * Feature flag: FACT_COMPRESSION (default: false, opt-in)
 * Threshold: COMPRESS_THRESHOLD (default: 3)
 */

import type { CompiledMemory } from '../schema/memory.js';
import { createLogger } from '../config.js';

const log = createLogger('compress');

/**
 * Compress a list of memories by grouping and merging per-subject facts.
 * Returns a potentially shorter list with composite claims.
 */
export function compressFacts(memories: CompiledMemory[]): CompiledMemory[] {
  if (process.env.FACT_COMPRESSION !== 'true') return memories;

  const threshold = parseInt(process.env.COMPRESS_THRESHOLD || '3', 10);

  // Group by subject
  const groups = new Map<string, CompiledMemory[]>();
  for (const m of memories) {
    const subj = m.subject || 'General';
    if (!groups.has(subj)) groups.set(subj, []);
    groups.get(subj)!.push(m);
  }

  const result: CompiledMemory[] = [];
  let compressedCount = 0;

  for (const [subject, mems] of groups) {
    if (mems.length < threshold) {
      // Below threshold: pass through unchanged
      result.push(...mems);
      continue;
    }

    // Sort chronologically for coherent merging
    mems.sort((a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    // Deduplicate near-identical claims (cosine would be better, but string prefix is cheap)
    const uniqueClaims: CompiledMemory[] = [];
    const seen = new Set<string>();
    for (const m of mems) {
      // Normalize for dedup: lowercase, trim, remove subject prefix if present
      const key = m.claim.toLowerCase()
        .replace(new RegExp('^' + subject.toLowerCase() + '\\s+', 'i'), '')
        .replace(/\s+/g, ' ')
        .trim();
      // Check if we've seen a very similar claim (first 40 chars)
      const prefix = key.slice(0, 40);
      if (seen.has(prefix)) continue;
      seen.add(prefix);
      uniqueClaims.push(m);
    }

    // Split into chunks of MAX_CHUNK_SIZE for manageable composites
    const chunkSize = parseInt(process.env.COMPRESS_CHUNK_SIZE || '5', 10);
    const chunks: CompiledMemory[][] = [];
    for (let i = 0; i < uniqueClaims.length; i += chunkSize) {
      chunks.push(uniqueClaims.slice(i, i + chunkSize));
    }

    for (const chunk of chunks) {
      if (chunk.length === 1) {
        result.push(chunk[0]!);
        continue;
      }

      // Build composite claim
      // Strip redundant subject prefix from each claim before joining
      const strippedClaims = chunk.map(m => {
        let c = m.claim;
        // Remove leading "Subject verb" pattern to avoid "John ... John ... John ..."
        const subjectPattern = new RegExp('^' + escapeRegex(subject) + '\\s+', 'i');
        if (subjectPattern.test(c)) {
          c = c.replace(subjectPattern, '');
          // Lowercase first char since we removed the subject
          c = c.charAt(0).toLowerCase() + c.slice(1);
        }
        return c;
      });

      // Use the highest-scoring memory as the base for metadata
      const best = chunk.reduce((a, b) => a.score > b.score ? a : b);

      const compositeClaim = subject + ': ' + strippedClaims.join('; ') + '.';

      result.push({
        ...best,
        claim: compositeClaim,
        compressed: true,
      });
      compressedCount += chunk.length - 1;
    }
  }

  if (compressedCount > 0) {
    log.info(
      { original: memories.length, compressed: result.length, saved: compressedCount },
      'Fact compression applied',
    );
  }

  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Dedup-only: removes near-duplicate claims using Jaccard similarity.
 * NEVER merges. Only removes redundant copies. Keeps higher-scored one.
 * Feature flag: FACT_DEDUP (default: false, opt-in)
 */
function wordSet(claim: string): Set<string> {
  return new Set(
    claim.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(function(w) { return w.length > 1; })
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  const aArr = Array.from(a);
  for (let k = 0; k < aArr.length; k++) {
    if (b.has(aArr[k]!)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function dedupFacts(memories: CompiledMemory[]): CompiledMemory[] {
  if (process.env.FACT_DEDUP !== "true") return memories;
  const threshold = parseFloat(process.env.DEDUP_SIMILARITY || "0.82");
  const wordSets = memories.map(function(m) { return wordSet(m.claim); });
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

  const result = memories.filter(function(_, idx) { return !killed.has(idx); });
  if (killed.size > 0) {
    log.info({ original: memories.length, deduped: result.length, removed: killed.size }, "Dedup applied");
  }
  return result;
}
