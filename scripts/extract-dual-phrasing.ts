#!/usr/bin/env npx tsx
/**
 * Dual-phrasing extraction for LOCOMO conversations.
 * Each fact produces: atomic claim + question-aligned restatement.
 * Council R4 recommendation (Claude Incognito approach).
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ExtractedFact { claim: string; subject: string; }

function buildDualPhrasingPrompt(convText: string, speakerA: string, speakerB: string, sessionDate: string): string {
  const yearNum = parseInt(sessionDate.match(/\d{4}/)?.[0] || '2023');
  return `You are extracting structured facts from a conversation for a memory system. Every fact must be a standalone statement that could answer a question WITHOUT seeing the original conversation.

Speakers: ${speakerA} and ${speakerB}
Date of this conversation: ${sessionDate}

EXTRACTION RULES:
1. SPECIFIC DETAILS ARE CRITICAL. Extract exact names, places, countries, cities, numbers, ages, professions, hobbies, pet names, relationship statuses, school names, company names.
2. RESOLVE ALL RELATIVE TIME. "last year" = ${yearNum - 1}. "yesterday" = the day before ${sessionDate}. "last Saturday" = the Saturday before ${sessionDate}. "next month" = the month after ${sessionDate}. Write the resolved date in the claim.
3. IDENTITY AND BACKGROUND. Extract: nationality, where they moved from, gender identity, sexual orientation, relationship status, family members by name.
4. RELATIONSHIPS. "${speakerA} and ${speakerB} are friends." If they mention other people, extract who those people are and their relationship.
5. EVENTS WITH DATES. "X happened on [resolved date]" not "X happened recently."
6. OPINIONS AND PREFERENCES. "X prefers Y" or "X's favorite Z is W."
7. PLANS AND GOALS. "X plans to do Y" with timeframe if mentioned.
8. CAREER AND EDUCATION. Job titles, schools, certifications, fields of study.
9. DO NOT extract: greetings, "how are you", emotional reactions without factual content, vague statements.
10. Each claim must contain the subject's name. Not "she went" but "${speakerA} went."

DUAL PHRASING (CRITICAL):
For each fact, produce TWO versions:
- "claim": The atomic factual statement (what happened/is true).
- "alt": A question-answering restatement. Rephrase the same fact as if answering a likely question about it. Include inferences, lessons learned, realizations, and relationship directions.

Examples:
- claim: "Melanie carves out daily me-time for self-care"
  alt: "Melanie realized that self-care and taking time for herself is important"
- claim: "Caroline recommended the book Becoming Nicole to Melanie"
  alt: "The book that Caroline recommended to Melanie is Becoming Nicole"
- claim: "Jon moved from Austin to Seattle in March 2022"
  alt: "Jon relocated to Seattle from Austin, and this move happened in March 2022"

Return ONLY a JSON array: [{"claim": "...", "alt": "...", "subject": "Speaker Name"}, ...]
No markdown, no explanation.

Conversation:
${convText}`;
}

async function extractSession(
  turns: any[], speakerA: string, speakerB: string,
  sessionDate: string, apiKey: string
): Promise<ExtractedFact[]> {
  const convText = turns.map((t: any) =>
    `${t.speaker || t.role}: ${t.text || t.content}`
  ).join('\n');
  const prompt = buildDualPhrasingPrompt(convText, speakerA, speakerB, sessionDate);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = (await response.json()) as any;
  const text = data.content?.[0]?.text ?? '[]';
  const cleaned = text.replace(/```json\n?|```\n?/g, '').trim();
  const parsed = JSON.parse(cleaned);

  const flattened: ExtractedFact[] = [];
  for (const item of parsed) {
    flattened.push({ claim: item.claim, subject: item.subject });
    if (item.alt && item.alt !== item.claim) {
      flattened.push({ claim: item.alt, subject: item.subject });
    }
  }
  return flattened;
}

async function main() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) { console.error('ANTHROPIC_API_KEY required'); process.exit(1); }

  const args = process.argv.slice(2);
  const convIdx = args.indexOf('--conv');
  const singleConv = convIdx !== -1 ? parseInt(args[convIdx + 1] ?? '0', 10) : -1;

  const datasetPath = resolve(__dirname, '../fixtures/benchmark/locomo-official/locomo10.json');
  const dataset = JSON.parse(readFileSync(datasetPath, 'utf-8'));
  const outputPath = resolve(__dirname, '../fixtures/benchmark/locomo-official/extracted-facts-dual-all.json');

  const allConvFacts: Array<{conversation_index: number, facts: ExtractedFact[]}> =
    existsSync(outputPath) ? JSON.parse(readFileSync(outputPath, 'utf-8')) : [];

  const startIdx = singleConv >= 0 ? singleConv : 0;
  const endIdx = singleConv >= 0 ? singleConv + 1 : dataset.length;

  for (let ci = startIdx; ci < endIdx; ci++) {
    if (allConvFacts.find(c => c.conversation_index === ci)) {
      console.log(`[Conv ${ci}] Already extracted, skipping`);
      continue;
    }

    const conv = dataset[ci];
    const convData = conv.conversation;
    console.log(`\n[Conv ${ci}] Speakers: ${convData.speaker_a} + ${convData.speaker_b}`);

    const sessionKeys = Object.keys(convData)
      .filter(k => k.match(/^session_\d+$/) && Array.isArray(convData[k]))
      .sort((a, b) => parseInt(a.match(/\d+/)?.[0] || '0') - parseInt(b.match(/\d+/)?.[0] || '0'));

    const allFacts: ExtractedFact[] = [];
    for (const sessionKey of sessionKeys) {
      const sessionNum = sessionKey.match(/\d+/)?.[0];
      const dateKey = `session_${sessionNum}_date_time`;
      const sessionDate = convData[dateKey] || '';

      try {
        const facts = await extractSession(
          convData[sessionKey], convData.speaker_a, convData.speaker_b,
          sessionDate, anthropicKey
        );
        allFacts.push(...facts);
        const origCount = Math.ceil(facts.length / 2);
        console.log(`  Session ${sessionNum}: ${origCount} facts -> ${facts.length} with alts`);
      } catch (err) {
        console.error(`  Session ${sessionNum}: FAILED`, err instanceof Error ? err.message : err);
      }
      await new Promise(r => setTimeout(r, 200));
    }

    const seen = new Set<string>();
    const deduped = allFacts.filter(f => {
      const key = f.claim.toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`  Total: ${allFacts.length} raw, ${deduped.length} after dedup`);
    allConvFacts.push({ conversation_index: ci, facts: deduped });
    allConvFacts.sort((a, b) => a.conversation_index - b.conversation_index);
    writeFileSync(outputPath, JSON.stringify(allConvFacts, null, 2));
    console.log(`  Saved.`);
  }

  console.log(`\nDone. ${allConvFacts.length} conversations.`);
  const totalFacts = allConvFacts.reduce((sum, c) => sum + c.facts.length, 0);
  console.log(`Total facts: ${totalFacts}`);
}

main().catch(err => { console.error(err); process.exit(1); });
