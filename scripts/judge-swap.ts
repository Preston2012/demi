#!/usr/bin/env npx tsx
/**
 * Judge Swap: Re-judge existing LOCOMO results with a different model.
 * Zero retrieval. Reads saved JSON, calls new judge, compares scores.
 *
 * Usage:
 *   npx tsx scripts/judge-swap.ts --results <path.json> --judge gpt-4.1-mini
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const args = process.argv.slice(2);
  const resultsIdx = args.indexOf('--results');
  const judgeIdx = args.indexOf('--judge');

  if (resultsIdx === -1) {
    console.error('Usage: --results <path.json> [--judge gpt-4.1-mini]');
    process.exit(1);
  }

  const resultsPath = resolve(args[resultsIdx + 1]!);
  const judgeModel = judgeIdx !== -1 ? args[judgeIdx + 1]! : 'gpt-4.1-mini';

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    console.error('OPENAI_API_KEY required');
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(resultsPath, 'utf-8'));
  const results = data.results as any[];
  const oldJudge = data.config?.judgeModel || 'unknown';

  // Skip cat 5 (adversarial)
  const scored = results.filter((r: any) => r.category !== 5);
  console.log(`Judge swap: ${scored.length} scored questions`);
  console.log(`Old judge: ${oldJudge}`);
  console.log(`New judge: ${judgeModel}`);

  const CATEGORY_LABELS: Record<number, string> = {
    1: 'Multi-hop', 2: 'Temporal', 3: 'Open-domain', 4: 'Single-hop',
  };

  let newCorrect = 0;
  let oldCorrect = 0;
  const perCategory: Record<string, { oldC: number; newC: number; total: number }> = {};
  const flips: { question: string; expected: string; predicted: string; oldJudge: boolean; newJudge: boolean; category: string }[] = [];

  for (let i = 0; i < scored.length; i++) {
    const r = scored[i]!;
    const expected = r.expected_answer || r.expectedAnswer || '';
    const predicted = r.predicted_answer || r.actualAnswer || '';
    const cat = CATEGORY_LABELS[r.category] || 'Unknown';

    if (!perCategory[cat]) perCategory[cat] = { oldC: 0, newC: 0, total: 0 };
    perCategory[cat]!.total++;

    if (r.llm_judge_correct || r.correct) {
      oldCorrect++;
      perCategory[cat]!.oldC++;
    }

    // Call new judge
    const judgePrompt = `You are a strict benchmark evaluator. Respond ONLY with "yes" or "no".

Question: ${r.question}
Gold answer: ${expected}
System response: ${predicted}

Does the system response correctly answer the question? Accept paraphrases, synonyms, number words (eight = 8), and abbreviations as correct. Say "no" if the key information is missing, wrong, or contradicted.`;

    try {
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
        body: JSON.stringify({
          model: judgeModel, max_tokens: 10, temperature: 0,
          messages: [{ role: 'user', content: judgePrompt }],
        }),
      });
      const jd = (await resp.json()) as any;
      const judgeText = (jd.choices?.[0]?.message?.content ?? '').toLowerCase().trim();
      const newJudgeCorrect = judgeText.startsWith('yes');

      if (newJudgeCorrect) {
        newCorrect++;
        perCategory[cat]!.newC++;
      }

      // Track flips
      const oldJudgeCorrect = !!(r.llm_judge_correct || r.correct);
      if (oldJudgeCorrect !== newJudgeCorrect) {
        flips.push({
          question: r.question,
          expected,
          predicted: predicted.substring(0, 120),
          oldJudge: oldJudgeCorrect,
          newJudge: newJudgeCorrect,
          category: cat,
        });
      }

      if ((i + 1) % 100 === 0) {
        console.log(`  [${i + 1}/${scored.length}] old=${oldCorrect} new=${newCorrect} (delta: ${newCorrect > oldCorrect ? '+' : ''}${newCorrect - oldCorrect})`);
      }
    } catch (err) {
      console.error(`  Q${i}: judge error`, err instanceof Error ? err.message : err);
    }
  }

  // Report
  const oldAcc = (oldCorrect / scored.length * 100).toFixed(1);
  const newAcc = (newCorrect / scored.length * 100).toFixed(1);
  const delta = ((newCorrect - oldCorrect) / scored.length * 100).toFixed(1);

  console.log('\n========== JUDGE SWAP RESULTS ==========');
  console.log(`Questions:     ${scored.length}`);
  console.log(`Old (${oldJudge}): ${oldAcc}% (${oldCorrect}/${scored.length})`);
  console.log(`New (${judgeModel}):  ${newAcc}% (${newCorrect}/${scored.length})`);
  console.log(`Delta:         ${delta}pp (${newCorrect - oldCorrect > 0 ? '+' : ''}${newCorrect - oldCorrect} questions)`);

  console.log('\nPer category:');
  for (const [cat, counts] of Object.entries(perCategory)) {
    const oldP = (counts.oldC / counts.total * 100).toFixed(1);
    const newP = (counts.newC / counts.total * 100).toFixed(1);
    const d = ((counts.newC - counts.oldC) / counts.total * 100).toFixed(1);
    console.log(`  ${cat}: ${oldP}% -> ${newP}% (${d}pp, n=${counts.total})`);
  }

  console.log(`\nFlips: ${flips.length} total`);
  const gained = flips.filter(f => !f.oldJudge && f.newJudge);
  const lost = flips.filter(f => f.oldJudge && !f.newJudge);
  console.log(`  Gained (WRONG->CORRECT): ${gained.length}`);
  console.log(`  Lost (CORRECT->WRONG): ${lost.length}`);

  if (gained.length > 0) {
    console.log('\nSample gains:');
    for (const f of gained.slice(0, 5)) {
      console.log(`  [${f.category}] ${f.question.substring(0, 80)}`);
      console.log(`    Expected: ${f.expected.substring(0, 80)}`);
      console.log(`    Got: ${f.predicted}`);
    }
  }

  // Save report
  const outputDir = resolve(__dirname, '../benchmark-results');
  mkdirSync(outputDir, { recursive: true });
  const reportPath = resolve(outputDir, `judge-swap-${judgeModel}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    sourceFile: resultsPath,
    oldJudge, newJudge: judgeModel,
    oldAccuracy: oldCorrect / scored.length,
    newAccuracy: newCorrect / scored.length,
    delta: (newCorrect - oldCorrect) / scored.length,
    perCategory,
    flips,
  }, null, 2));
  console.log(`\nReport: ${reportPath}`);
}

main().catch(err => { console.error('Failed:', err); process.exit(1); });
