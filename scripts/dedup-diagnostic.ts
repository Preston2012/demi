/**
 * N-1 Diagnostic V2: Dual-phrasing + dedup tension.
 * Measures BOTH cosine (write-time @ 0.92) AND Jaccard (injection-time @ 0.82).
 */
import { readFileSync } from 'fs';
import { initialize, encode } from '../src/embeddings/index.js';

interface ExtractedFact { subject: string; claim: string; conversationIndex?: number; }

function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]!*b[i]!; magA += a[i]!*a[i]!; magB += b[i]!*b[i]!; }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function jaccardSim(a: string, b: string): number {
  const tokA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const tokB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  let intersection = 0;
  for (const t of tokA) if (tokB.has(t)) intersection++;
  const union = tokA.size + tokB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function pct(n: number, total: number): string { return `${((n/total)*100).toFixed(1)}%`; }

async function main() {
  await initialize(process.env.MODEL_PATH || './models/bge-small-en-v1.5.onnx');
  const raw = JSON.parse(readFileSync('fixtures/benchmark/locomo-official/extracted-facts-dual-all.json', 'utf8'));
  const bySubject = new Map<string, ExtractedFact[]>();
  const allFacts: ExtractedFact[] = [];
  for (const convObj of raw as any[]) {
    for (const f of convObj.facts as ExtractedFact[]) {
      allFacts.push(f);
      const key = f.subject.toLowerCase().trim();
      if (!bySubject.has(key)) bySubject.set(key, []);
      bySubject.get(key)!.push(f);
    }
  }
  console.log(`Total facts: ${allFacts.length}, Unique subjects: ${bySubject.size}`);

  const pairs: { cosine: number; jaccard: number; a: string; b: string }[] = [];
  let sampledSubjects = 0;
  for (const [, facts] of bySubject) {
    if (facts.length < 2) continue;
    sampledSubjects++;
    for (let i = 0; i < Math.min(facts.length - 1, 3); i++) {
      const a = facts[i]!, b = facts[i+1]!;
      const embA = await encode(a.claim), embB = await encode(b.claim);
      pairs.push({
        cosine: cosineSim(embA, embB),
        jaccard: jaccardSim(a.claim, b.claim),
        a: a.claim.substring(0, 65), b: b.claim.substring(0, 65)
      });
      if (pairs.length >= 100) break;
    }
    if (pairs.length >= 100) break;
  }
  pairs.sort((a, b) => b.cosine - a.cosine);

  console.log(`\nSampled ${pairs.length} pairs from ${sampledSubjects} subjects`);

  const cosAbove92 = pairs.filter(p => p.cosine >= 0.92);
  const cos85to92 = pairs.filter(p => p.cosine >= 0.85 && p.cosine < 0.92);
  const cosBelow85 = pairs.filter(p => p.cosine < 0.85);
  console.log(`\n=== COSINE (write-time @ 0.92) ===`);
  console.log(`  >= 0.92 (DEDUPED):  ${cosAbove92.length} (${pct(cosAbove92.length, pairs.length)})`);
  console.log(`  0.85-0.92 (DANGER): ${cos85to92.length} (${pct(cos85to92.length, pairs.length)})`);
  console.log(`  < 0.85 (SAFE):      ${cosBelow85.length} (${pct(cosBelow85.length, pairs.length)})`);

  const jacAbove82 = pairs.filter(p => p.jaccard >= 0.82);
  const jac70to82 = pairs.filter(p => p.jaccard >= 0.70 && p.jaccard < 0.82);
  const jacBelow70 = pairs.filter(p => p.jaccard < 0.70);
  console.log(`\n=== JACCARD (injection-time FACT_DEDUP @ 0.82) ===`);
  console.log(`  >= 0.82 (DEDUPED):  ${jacAbove82.length} (${pct(jacAbove82.length, pairs.length)})`);
  console.log(`  0.70-0.82 (DANGER): ${jac70to82.length} (${pct(jac70to82.length, pairs.length)})`);
  console.log(`  < 0.70 (SAFE):      ${jacBelow70.length} (${pct(jacBelow70.length, pairs.length)})`);

  const cosDedup_jacKeep = pairs.filter(p => p.cosine >= 0.92 && p.jaccard < 0.82);
  const cosKeep_jacDedup = pairs.filter(p => p.cosine < 0.92 && p.jaccard >= 0.82);
  console.log(`\n=== DISAGREEMENTS ===`);
  console.log(`  Cosine dedup + Jaccard keep: ${cosDedup_jacKeep.length} (cosine over-aggressive)`);
  console.log(`  Cosine keep + Jaccard dedup: ${cosKeep_jacDedup.length} (jaccard over-aggressive)`);
  if (cosDedup_jacKeep.length > 0) {
    console.log(`\n  Cosine over-aggressive examples:`);
    for (const p of cosDedup_jacKeep.slice(0, 8)) {
      console.log(`    cos=${p.cosine.toFixed(3)} jac=${p.jaccard.toFixed(3)} | "${p.a}" vs "${p.b}"`);
    }
  }

  // Injection survival simulation for first 3 conversations
  console.log(`\n=== INJECTION SURVIVAL (Jaccard 0.82) ===`);
  for (const convObj of (raw as any[]).slice(0, 3)) {
    const convFacts = convObj.facts as ExtractedFact[];
    const convIdx = convObj.conversation_index;
    let deduped = 0;
    const keptClaims: string[] = [];
    for (const f of convFacts) {
      let isDup = false;
      for (const existing of keptClaims) {
        if (jaccardSim(f.claim, existing) >= 0.82) { isDup = true; deduped++; break; }
      }
      if (!isDup) keptClaims.push(f.claim);
    }
    console.log(`  Conv ${convIdx}: ${convFacts.length} -> ${keptClaims.length} kept, ${deduped} deduped (${pct(deduped, convFacts.length)} lost)`);
  }

  // Comparison table
  console.log(`\nTop 15 pairs (by cosine):`);
  console.log(`  ${'Cos'.padEnd(7)} ${'Jac'.padEnd(7)} ${'Gap'.padEnd(6)} Claims`);
  for (const p of pairs.slice(0, 15)) {
    console.log(`  ${p.cosine.toFixed(4)} ${p.jaccard.toFixed(4)} ${(p.cosine-p.jaccard).toFixed(2).padStart(5)}  "${p.a}" vs "${p.b}"`);
  }

  // Verdict
  console.log(`\n=== VERDICT ===`);
  console.log(`Write-time (cosine 0.92): ${cosAbove92.length}/${pairs.length} deduped`);
  console.log(`Inject-time (Jaccard 0.82): ${jacAbove82.length}/${pairs.length} deduped`);
  if (jacAbove82.length < cosAbove92.length * 0.5) {
    console.log(`FINDING: Jaccard much more permissive than cosine.`);
    console.log(`Dual-phrased variants survive injection dedup. Current threshold OK for benchmarks.`);
    if (cosDedup_jacKeep.length > 10) {
      console.log(`POTENTIAL WIN: ${cosDedup_jacKeep.length} pairs survive Jaccard but would die at write-time.`);
      console.log(`If production write-path uses cosine 0.92, lower to 0.95 or exact-match.`);
    }
  } else if (jacAbove82.length > pairs.length * 0.4) {
    console.log(`WARNING: Jaccard eating >${pct(jacAbove82.length, pairs.length)} of pairs.`);
    console.log(`ACTION: A/B test with Jaccard 0.85 or 0.90.`);
  } else {
    console.log(`OK: Both thresholds working as intended.`);
  }
}

main().catch(console.error);
