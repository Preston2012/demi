#!/usr/bin/env npx tsx
/**
 * Embedding quality comparison: BGE-small (384d) vs OpenAI text-embedding-3-small (1536d)
 * 
 * Standalone test. No pipeline changes. Embeds v2 facts + questions with OpenAI,
 * does cosine similarity ranking, measures retrieval recall.
 * 
 * Cost: ~$0.01 (292 facts + 152 questions ≈ 50K tokens)
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CATEGORY_LABELS: Record<number, string> = {
  1: 'Multi-hop', 2: 'Temporal', 3: 'Open-domain', 4: 'Single-hop',
};

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embedBatch(texts: string[], apiKey: string, model: string): Promise<number[][]> {
  const batchSize = 100;
  const allEmbeddings: number[][] = [];
  
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const resp = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: batch }),
    });
    const data = (await resp.json()) as any;
    if (data.error) throw new Error(data.error.message);
    const sorted = data.data.sort((a: any, b: any) => a.index - b.index);
    allEmbeddings.push(...sorted.map((d: any) => d.embedding));
    console.log(`  Embedded ${Math.min(i + batchSize, texts.length)}/${texts.length}`);
  }
  
  return allEmbeddings;
}

async function main() {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) { console.error('OPENAI_API_KEY required'); process.exit(1); }
  
  const maxRules = 25;
  
  // Load facts and dataset
  const facts = JSON.parse(readFileSync(resolve(__dirname, '../benchmark-results/extraction-v2.json'), 'utf8'));
  const dataset = JSON.parse(readFileSync(resolve(__dirname, '../fixtures/benchmark/locomo-official/locomo10.json'), 'utf8'));
  const conv = dataset[0];
  const scoredQa = conv.qa.filter((q: any) => q.category !== 5 && q.answer);
  
  console.log(`Facts: ${facts.length}, Questions: ${scoredQa.length}`);
  
  // Embed all facts
  console.log('\nEmbedding facts with text-embedding-3-small...');
  const factTexts = facts.map((f: any) => f.claim);
  const factEmbeddings = await embedBatch(factTexts, openaiKey, 'text-embedding-3-small');
  
  // Embed all questions
  console.log('\nEmbedding questions...');
  const questionTexts = scoredQa.map((q: any) => q.question);
  const questionEmbeddings = await embedBatch(questionTexts, openaiKey, 'text-embedding-3-small');
  
  // For each question, rank facts by cosine similarity and check recall
  console.log('\nMeasuring retrieval recall...');
  const catStats: Record<number, { total: number; recalled: number }> = {};
  
  for (let qi = 0; qi < scoredQa.length; qi++) {
    const qa = scoredQa[qi];
    const qEmb = questionEmbeddings[qi];
    
    // Rank all facts by cosine similarity
    const scores = factEmbeddings.map((fEmb, fi) => ({ idx: fi, score: cosine(qEmb, fEmb) }));
    scores.sort((a, b) => b.score - a.score);
    
    // Top-N facts
    const topN = scores.slice(0, maxRules);
    const retrievedText = topN.map(s => factTexts[s.idx].toLowerCase()).join(' ');
    
    const answer = String(qa.answer).toLowerCase();
    const answerTokens = answer.split(/\s+/).filter((t: string) => t.length > 2);
    const matchedTokens = answerTokens.filter((t: string) => retrievedText.includes(t));
    const recall = answerTokens.length > 0 ? matchedTokens.length / answerTokens.length : 0;
    const recalled = recall >= 0.5;
    
    if (!catStats[qa.category]) catStats[qa.category] = { total: 0, recalled: 0 };
    catStats[qa.category].total++;
    if (recalled) catStats[qa.category].recalled++;
  }
  
  // Report
  console.log(`\n=== RETRIEVAL RECALL: OpenAI text-embedding-3-small (1536d) ===`);
  console.log(`maxRules: ${maxRules}\n`);
  let totalAll = 0, recalledAll = 0;
  for (const [cat, stats] of Object.entries(catStats).sort(([a], [b]) => Number(a) - Number(b))) {
    const pct = (stats.recalled / stats.total * 100).toFixed(1);
    console.log(`  ${CATEGORY_LABELS[Number(cat)]}: ${stats.recalled}/${stats.total} = ${pct}%`);
    totalAll += stats.total;
    recalledAll += stats.recalled;
  }
  console.log(`\n  Overall: ${recalledAll}/${totalAll} = ${(recalledAll / totalAll * 100).toFixed(1)}%`);
  
  console.log(`\n=== COMPARISON (same v2 facts, maxRules=25) ===`);
  console.log(`  BGE-small (384d):  33.6% recall`);
  console.log(`  OpenAI (1536d):    ${(recalledAll / totalAll * 100).toFixed(1)}% recall`);
  console.log(`  Delta:             ${((recalledAll / totalAll - 0.336) * 100).toFixed(1)} pts`);
}

main().catch(err => { console.error(err); process.exit(1); });
