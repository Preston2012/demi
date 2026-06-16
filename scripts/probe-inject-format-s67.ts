/**
 * S67 inject-format probe v2, verify chronological sort fires regardless of INJECT_FORMAT.
 *
 * v2 fix: parse only the "--- Memory Context ---" block, not the whole output.
 * v1 was matching against [Entity Profiles] which has its own ordering.
 */
import { formatForContext } from '../src/inject/index.js';
import type { InjectionPayload } from '../src/schema/memory.js';

const m1 = {
  id: 'm1',
  claim: 'User started learning Python',
  subject: 'skills',
  scope: 'global' as const,
  provenance: 'user' as const,
  trustClass: 'user-confirmed' as const,
  confidence: 0.9,
  createdAt: '2024-01-15T10:00:00.000Z',
  validFrom: '2024-01-15T10:00:00.000Z',
  score: 0.85,
  slot: 'fact' as const,
  position: 'context' as const,
  compressed: false,
};

const m2 = {
  id: 'm2',
  claim: 'User learned Flask framework',
  subject: 'skills',
  scope: 'global' as const,
  provenance: 'user' as const,
  trustClass: 'user-confirmed' as const,
  confidence: 0.9,
  createdAt: '2024-03-20T10:00:00.000Z',
  validFrom: '2024-03-20T10:00:00.000Z',
  score: 0.95,
  slot: 'fact' as const,
  position: 'context' as const,
  compressed: false,
};

const m3 = {
  id: 'm3',
  claim: 'User deployed first web app',
  subject: 'skills',
  scope: 'global' as const,
  provenance: 'user' as const,
  trustClass: 'user-confirmed' as const,
  confidence: 0.9,
  createdAt: '2024-05-01T10:00:00.000Z',
  validFrom: '2024-05-01T10:00:00.000Z',
  score: 0.75,
  slot: 'fact' as const,
  position: 'context' as const,
  compressed: false,
};

const memoriesByScore = [m2, m1, m3];

function extractMemoryContextOrder(out: string): string[] {
  // Find the line range between "--- Memory Context (...) ---" and the next "---"
  const startMatch = out.match(/--- Memory Context \([^)]+\) ---/);
  if (!startMatch) return [];
  const startIdx = out.indexOf(startMatch[0]) + startMatch[0].length;
  const rest = out.slice(startIdx);
  const endIdx = rest.indexOf('\n---');
  const block = endIdx >= 0 ? rest.slice(0, endIdx) : rest;

  // Match the [M1] / [M2] / [M3] tagged lines and capture which CLAIM they hold
  const order: string[] = [];
  const lines = block.split('\n');
  for (const line of lines) {
    if (line.includes('User started learning Python')) order.push('m1');
    else if (line.includes('User learned Flask framework')) order.push('m2');
    else if (line.includes('User deployed first web app')) order.push('m3');
  }
  return order;
}

function probeQuery(query: string, fmt: string, label: string, expectChronological: boolean): boolean {
  if (fmt) process.env.INJECT_FORMAT = fmt;
  else delete process.env.INJECT_FORMAT;

  const payload: InjectionPayload = {
    knowledgeMap: null,
    memories: memoriesByScore,
    conflicts: [],
    conflictTags: {},
    inhibitions: [],
    metadata: {
      queryUsed: query,
      candidatesEvaluated: 3,
      retrievalTimeMs: 10,
      hubExpansions: 0,
      crossDomainHops: 0,
      inhibitionsSuppressed: 0,
      primingHits: 0,
      queryType: 'temporal',
      nowIso: '2024-06-01T00:00:00.000Z',
    },
  };

  const out = formatForContext(payload);
  const order = extractMemoryContextOrder(out);

  console.log(`\n=== ${label} ===`);
  console.log(`Query: "${query}"`);
  console.log(`INJECT_FORMAT: ${fmt || '(unset, default=full)'}`);
  console.log(`Memory context order: ${order.join(' → ')}`);
  const actual = order.join(',');
  const expected = expectChronological ? 'm1,m2,m3' : 'm2,m1,m3';
  if (actual === expected) {
    console.log(`✅ PASS, order is ${expectChronological ? 'CHRONOLOGICAL' : 'RELEVANCE-DESCENDING'}`);
    return true;
  } else {
    console.log(`❌ FAIL, got ${actual}, expected ${expected}`);
    return false;
  }
}

console.log('=== S67 INJECT-FORMAT PROBE v2 ===');

const results: boolean[] = [];

results.push(
  probeQuery(
    'walk me through the order in which I learned different things',
    '',
    'Test 1: chronological keyword + default fmt=full',
    true,
  ),
);

results.push(
  probeQuery(
    'list my skills in the order I acquired them',
    'full',
    'Test 2: chronological keyword + explicit fmt=full',
    true,
  ),
);

results.push(probeQuery('when did each of these happen', 'clean', 'Test 3: chronological keyword + fmt=clean', true));

results.push(
  probeQuery(
    'walk me through my learning sequence',
    'packed',
    'Test 4: chronological keyword + fmt=packed (regression check)',
    true,
  ),
);

results.push(probeQuery('what skills do I have', '', 'Test 5: non-chronological, relevance order m2 first', false));

const passed = results.filter(Boolean).length;
console.log(`\n=== ${passed}/${results.length} PASS ===`);
process.exit(passed === results.length ? 0 : 1);
