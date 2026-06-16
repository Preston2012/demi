#!/usr/bin/env npx tsx
/**
 * LOCOMO Pipeline Test, Measures retrieval recall with different extraction strategies.
 *
 * Usage:
 *   npx tsx scripts/locomo-pipeline-test.ts --mode observations   # Paper's observations
 *   npx tsx scripts/locomo-pipeline-test.ts --mode extract         # Our extraction via Haiku
 *   npx tsx scripts/locomo-pipeline-test.ts --mode combined        # Both merged, dedup handles overlaps
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CATEGORY_LABELS: Record<number, string> = {
  1: 'Multi-hop',
  2: 'Temporal',
  3: 'Open-domain',
  4: 'Single-hop',
  5: 'Adversarial',
};

interface Observation {
  claim: string;
  subject: string;
  diaId: string;
  sessionDate: string;
}

function extractObservationsFromDataset(conv: any): Observation[] {
  const observations: Observation[] = [];
  const obsData = conv.observation;
  const convData = conv.conversation;

  for (const sessionKey of Object.keys(obsData)) {
    const sessionNum = sessionKey.match(/session_(\d+)/)?.[1];
    if (!sessionNum) continue;

    const dateKey = `session_${sessionNum}_date_time`;
    const sessionDate = convData[dateKey] || '';

    const sessionObs = obsData[sessionKey];
    if (!sessionObs || typeof sessionObs !== 'object') continue;

    for (const [speaker, claims] of Object.entries(sessionObs)) {
      if (!Array.isArray(claims)) continue;
      for (const entry of claims) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const [claimText, diaId] = entry;
        observations.push({ claim: claimText, subject: speaker, diaId, sessionDate });
      }
    }
  }

  return observations;
}

async function extractViaHaiku(conv: any, apiKey: string): Promise<Observation[]> {
  const convData = conv.conversation;
  const observations: Observation[] = [];

  const sessionKeys = Object.keys(convData)
    .filter((k) => k.match(/^session_\d+$/) && Array.isArray(convData[k]))
    .sort((a, b) => parseInt(a.match(/\d+/)?.[0] || '0') - parseInt(b.match(/\d+/)?.[0] || '0'));

  for (const sessionKey of sessionKeys) {
    const sessionNum = sessionKey.match(/\d+/)?.[0];
    const dateKey = `session_${sessionNum}_date_time`;
    const sessionDate = convData[dateKey] || '';
    const turns = convData[sessionKey];

    const convText = turns.map((t: any) => `${t.speaker}: ${t.text}`).join('\n');

    const prompt = `Extract ALL personal facts, events, preferences, relationships, dates, and temporal details from this conversation between ${convData.speaker_a} and ${convData.speaker_b}.

This conversation takes place on: ${sessionDate}

For each fact:
- Write a clear, standalone claim that includes specific details (names, dates, numbers, places)
- Resolve relative time references: "last year" from ${sessionDate} means the year before. "yesterday" means the day before ${sessionDate}. "last Saturday" means the Saturday before ${sessionDate}. "next month" means the month after ${sessionDate}.
- Attribute each fact to the correct speaker
- Include relationship facts between speakers
- Do NOT include greetings, pleasantries, or filler

Return ONLY a JSON array. Each element: {"claim": "...", "subject": "Speaker Name"}
No markdown, no explanation, just the JSON array.

Conversation:
${convText}`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 4096,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      const data = (await response.json()) as { content: Array<{ text: string }> };
      const text = data.content?.[0]?.text ?? '[]';
      const cleaned = text.replace(/```json\n?|```\n?/g, '').trim();
      const facts = JSON.parse(cleaned);

      for (const fact of facts) {
        observations.push({ claim: fact.claim, subject: fact.subject, diaId: '', sessionDate });
      }

      console.log(`    Session ${sessionNum}: ${facts.length} facts extracted`);
    } catch (err) {
      console.error(`    Session ${sessionNum}: extraction failed`, err instanceof Error ? err.message : err);
    }
  }

  return observations;
}

async function main() {
  const args = process.argv.slice(2);
  const modeIdx = args.indexOf('--mode');
  const mode = modeIdx !== -1 ? args[modeIdx + 1] : 'observations';
  const maxRulesIdx = args.indexOf('--max-rules');
  const maxRules = maxRulesIdx !== -1 ? parseInt(args[maxRulesIdx + 1] ?? '25', 10) : 25;
  const limitConvosIdx = args.indexOf('--limit-convos');
  const limitConvos = limitConvosIdx !== -1 ? parseInt(args[limitConvosIdx + 1] ?? '1', 10) : 1;

  process.env.DEMIURGE_API_KEY = process.env.DEMIURGE_API_KEY || 'benchmark-' + 'a'.repeat(24);
  process.env.DB_PATH = ':memory:';
  process.env.LOG_LEVEL = 'warn';

  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig();

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if ((mode === 'extract' || mode === 'combined') && !anthropicKey) {
    console.error('ANTHROPIC_API_KEY required for extract/combined mode');
    process.exit(1);
  }

  const { initialize: initEmbeddings } = await import('../src/embeddings/index.js');
  await initEmbeddings(config.modelPath);
  console.log('Embeddings loaded');

  const datasetPath = resolve(__dirname, '../fixtures/benchmark/locomo-official/locomo10.json');
  const dataset = JSON.parse(readFileSync(datasetPath, 'utf-8'));

  const { SqliteMemoryRepository } = await import('../src/repository/sqlite/index.js');
  const { createCoreDispatch } = await import('../src/core/dispatch.js');

  for (let ci = 0; ci < Math.min(limitConvos, dataset.length); ci++) {
    const conv = dataset[ci];
    console.log(`\n[Conv ${ci}] Mode: ${mode}, maxRules: ${maxRules}`);

    let observations: Observation[];
    if (mode === 'extract') {
      console.log('  Extracting via Haiku...');
      observations = await extractViaHaiku(conv, anthropicKey!);
    } else if (mode === 'combined') {
      console.log('  Loading paper observations...');
      const paperObs = extractObservationsFromDataset(conv);
      console.log(`  ${paperObs.length} paper observations`);
      console.log('  Extracting via Haiku...');
      const haikuObs = await extractViaHaiku(conv, anthropicKey!);
      console.log(`  ${haikuObs.length} Haiku extractions`);
      // Paper observations first (higher quality factual), Haiku second (temporal resolution)
      // Pipeline dedup handles overlaps
      observations = [...paperObs, ...haikuObs];
    } else {
      observations = extractObservationsFromDataset(conv);
    }

    console.log(`  ${observations.length} total observations to seed`);

    // Seed through Demiurge pipeline
    const repo = new SqliteMemoryRepository({ ...config, dbPath: ':memory:' });
    await repo.initialize();
    await repo.setMetadata('last_activity', new Date().toISOString());
    const dispatch = createCoreDispatch(repo, config);

    let seeded = 0;
    let rejected = 0;
    let quarantined = 0;

    for (const obs of observations) {
      try {
        const result = await dispatch.addMemory({
          claim: obs.claim,
          subject: obs.subject,
          source: 'user',
          confidence: 0.9,
        });
        if (result.action === 'rejected') rejected++;
        else if (result.action === 'quarantined') quarantined++;
        else seeded++;
      } catch {
        rejected++;
      }
    }

    console.log(`  Pipeline: ${seeded} stored, ${quarantined} quarantined, ${rejected} rejected (deduped)`);

    // Measure retrieval recall
    const catStats: Record<number, { total: number; recalled: number }> = {};

    for (const qa of conv.qa) {
      if (qa.category === 5) continue;
      const answer = String(qa.answer || '').toLowerCase();
      if (!answer || answer === 'n/a') continue;

      const searchResult = await dispatch.search(qa.question, maxRules);
      const retrievedText = searchResult.payload.memories.map((m: any) => m.claim.toLowerCase()).join(' ');

      const answerTokens = answer.split(/\s+/).filter((t: string) => t.length > 2);
      const matchedTokens = answerTokens.filter((t: string) => retrievedText.includes(t));
      const recall = answerTokens.length > 0 ? matchedTokens.length / answerTokens.length : 0;
      const recalled = recall >= 0.5;

      if (!catStats[qa.category]) catStats[qa.category] = { total: 0, recalled: 0 };
      catStats[qa.category].total++;
      if (recalled) catStats[qa.category].recalled++;
    }

    console.log(`\n  === RETRIEVAL RECALL (${mode}) ===`);
    let totalAll = 0,
      recalledAll = 0;
    for (const [cat, stats] of Object.entries(catStats).sort(([a], [b]) => Number(a) - Number(b))) {
      const pct = ((stats.recalled / stats.total) * 100).toFixed(1);
      console.log(`  ${CATEGORY_LABELS[Number(cat)]}: ${stats.recalled}/${stats.total} = ${pct}%`);
      totalAll += stats.total;
      recalledAll += stats.recalled;
    }
    console.log(`\n  Overall: ${recalledAll}/${totalAll} = ${((recalledAll / totalAll) * 100).toFixed(1)}%`);

    await repo.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
