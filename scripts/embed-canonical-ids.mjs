#!/usr/bin/env node
/**
 * Embed canonical_fact_id and isCanonical into extracted-facts-dual-all.json.
 * Consecutive pairs are dual-phrasings of the same fact.
 * First in pair = canonical (isCanonical: true), second = alternate.
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const filePath = resolve('./fixtures/benchmark/locomo-official/extracted-facts-dual-all.json');
const data = JSON.parse(readFileSync(filePath, 'utf-8'));

for (const conv of data) {
  const ci = conv.conversation_index;
  for (let i = 0; i < conv.facts.length; i++) {
    const familyIndex = Math.floor(i / 2);
    conv.facts[i].canonicalFactId = `fam-${ci}-${familyIndex}`;
    conv.facts[i].isCanonical = (i % 2 === 0);
  }
}

writeFileSync(filePath, JSON.stringify(data, null, 2));
console.log(`Embedded canonical IDs in ${data.length} conversations`);
for (const conv of data) {
  const families = new Set(conv.facts.map(f => f.canonicalFactId));
  console.log(`  Conv ${conv.conversation_index}: ${conv.facts.length} facts, ${families.size} families`);
}
