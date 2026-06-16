#!/usr/bin/env npx tsx
/**
 * Re-judge existing results with Sonnet to check if Haiku judge is too harsh.
 * Takes 20 "wrong" answers and re-evaluates with claude-sonnet-4-20250514.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('ANTHROPIC_API_KEY required'); process.exit(1); }

  // Load full results (152 questions, all categories)
  const d = JSON.parse(readFileSync(resolve(__dirname, '../benchmark-results/bench-v2-mr25-1775828922886.json'), 'utf8'));
  const wrong = d.results.filter((r: any) => !r.correct);
  
  // Sample 20 wrong answers spread across categories
  const sample: any[] = [];
  for (let cat = 1; cat <= 4; cat++) {
    const catWrong = wrong.filter((r: any) => r.category === cat);
    const take = Math.min(5, catWrong.length);
    sample.push(...catWrong.slice(0, take));
  }
  
  console.log(`Re-judging ${sample.length} "wrong" answers with Sonnet`);
  let flipped = 0;
  
  for (let i = 0; i < sample.length; i++) {
    const r = sample[i];
    const labels: Record<number,string> = {1:'Multi-hop',2:'Temporal',3:'Open-domain',4:'Single-hop'};
    
    const judgeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514', max_tokens: 10, temperature: 0,
        messages: [{ role: 'user', content: `You are a strict benchmark evaluator. Respond ONLY with "yes" or "no".

Question: ${r.question}
Gold answer: ${r.expected}
System response: ${r.predicted}

Does the system response correctly answer the question? Accept paraphrases, synonyms, number words (eight = 8), and abbreviations as correct. Say "no" if the key information is missing, wrong, or contradicted.` }],
      }),
    });
    const sonnetVerdict = ((await judgeResp.json()) as any).content?.[0]?.text?.toLowerCase().trim().startsWith('yes');
    
    if (sonnetVerdict) {
      flipped++;
      console.log(`  FLIPPED [${labels[r.category]}]: "${r.question.substring(0,50)}"`);
      console.log(`    Expected: ${r.expected.substring(0,60)}`);
      console.log(`    Got: ${r.predicted.substring(0,80)}`);
    }
  }
  
  console.log(`\n=== JUDGE COMPARISON ===`);
  console.log(`Sample: ${sample.length} Haiku-rejected answers`);
  console.log(`Sonnet agreed (still wrong): ${sample.length - flipped}`);
  console.log(`Sonnet flipped to correct: ${flipped}`);
  console.log(`Flip rate: ${(flipped/sample.length*100).toFixed(1)}%`);
  console.log(`\nIf applied to all ${wrong.length} wrong answers:`);
  console.log(`  Estimated flips: ~${Math.round(wrong.length * flipped/sample.length)}`);
  console.log(`  New J-Score estimate: ~${((d.results.filter((r:any)=>r.correct).length + Math.round(wrong.length * flipped/sample.length)) / d.results.length * 100).toFixed(1)}%`);
}

main().catch(err => { console.error(err); process.exit(1); });
