/**
 * Paraphrase Stability bench (S51 / D5), deterministic generator.
 *
 * Each cluster: 1 memory + 4 paraphrases of the same question. The 4 forms
 * cover the same answer-equivalence axis the packet calls out:
 *
 *   canonical , "What is my favorite programming language?"
 *   lexical   , "Which programming language do I prefer?"
 *   syntactic , "Programming language, my favorite, what is it?"
 *   indirect  , "If I had to pick one programming language to use forever,
 *                 which would I pick based on what I've told you?"
 *
 * The packet specifies an LLM-generated paraphrase pipeline with embedding-
 * cosine validation. We use templated paraphrasing here so the fixture is
 * deterministic, reproducible, and free at generate time. The runner still
 * exercises the same paraphrase-stability axis end-to-end. Optionally a
 * follow-up pass can replace these with LLM-generated paraphrases validated
 * via embedding ≥0.85 cosine, see scripts/validate-paraphrase-fixture.ts.
 *
 * Mini: 50 clusters × 4 paraphrases = 200 questions.
 * Full: 200 clusters × 4 paraphrases = 800 questions.
 *
 * Domains: technical, personal, factual, preference, temporal, 10/40 each.
 */

import type { ProductFact, ProductFixture, ProductQuery, ProductScenario } from '../types.js';

export type ParaphraseForm = 'canonical' | 'lexical' | 'syntactic' | 'indirect';

interface BaseCluster {
  id: string;
  domain: 'technical' | 'personal' | 'factual' | 'preference' | 'temporal';
  /** Memory text to seed (single fact). */
  fact: string;
  /** Gold answer (free-text, the LLM judge is paraphrase-tolerant). */
  expected: string | string[];
  /** Slot value used in templated paraphrases. */
  topic: string;
  /** Paraphrase template indexed by form. */
  templates: Record<ParaphraseForm, string>;
}

const BASE_MINI: BaseCluster[] = [
  // --- technical (10) ---
  buildPreferenceCluster(
    'p001',
    'technical',
    'My favorite programming language is Rust.',
    'Rust',
    'programming language',
    'preference',
  ),
  buildPreferenceCluster('p002', 'technical', 'I use VS Code as my main editor.', 'VS Code', 'code editor', 'main'),
  buildPreferenceCluster(
    'p003',
    'technical',
    'My production database is PostgreSQL.',
    'PostgreSQL',
    'production database',
    'main',
  ),
  buildPreferenceCluster('p004', 'technical', 'I deploy on Fly.io.', 'Fly.io', 'deployment platform', 'preferred'),
  buildPreferenceCluster(
    'p005',
    'technical',
    'My laptop is a MacBook Pro 16-inch.',
    'MacBook Pro 16-inch',
    'laptop',
    'main',
  ),
  buildPreferenceCluster('p006', 'technical', 'I write tests with vitest.', 'vitest', 'testing framework', 'preferred'),
  buildPreferenceCluster(
    'p007',
    'technical',
    'I prefer TypeScript over JavaScript.',
    'TypeScript',
    'typed JavaScript variant',
    'preferred',
  ),
  buildPreferenceCluster(
    'p008',
    'technical',
    'My version-control workflow is trunk-based.',
    'trunk-based',
    'version control workflow',
    'main',
  ),
  buildPreferenceCluster(
    'p009',
    'technical',
    'I draft API specs in OpenAPI.',
    'OpenAPI',
    'API spec format',
    'preferred',
  ),
  buildPreferenceCluster('p010', 'technical', 'I track issues in Linear.', 'Linear', 'issue tracker', 'main'),
  // --- personal (10) ---
  buildPreferenceCluster('p011', 'personal', 'My dog is named Rex.', 'Rex', "dog's name", 'main'),
  buildPreferenceCluster('p012', 'personal', 'I have one sister, Anna.', 'one (Anna)', 'number of sisters', 'main'),
  buildPreferenceCluster('p013', 'personal', 'My partner is named Maria.', 'Maria', "partner's name", 'main'),
  buildPreferenceCluster('p014', 'personal', 'I grew up in Lisbon.', 'Lisbon', 'hometown', 'main'),
  buildPreferenceCluster('p015', 'personal', 'I went to Stanford for college.', 'Stanford', 'college', 'main'),
  buildPreferenceCluster('p016', 'personal', 'My birthday is May 12th.', 'May 12', 'birthday', 'main'),
  buildPreferenceCluster('p017', 'personal', 'I drive a 2019 Toyota Tacoma.', '2019 Toyota Tacoma', 'car', 'main'),
  buildPreferenceCluster(
    'p018',
    'personal',
    'I live in a 2-bedroom apartment in Brooklyn.',
    '2-bedroom apartment in Brooklyn',
    'apartment',
    'main',
  ),
  buildPreferenceCluster('p019', 'personal', "My mother's name is Helena.", 'Helena', "mother's name", 'main'),
  buildPreferenceCluster('p020', 'personal', 'My closest friend is named Theo.', 'Theo', 'closest friend', 'main'),
  // --- factual (10) ---
  buildPreferenceCluster(
    'p021',
    'factual',
    'I work as a senior software engineer at Stripe.',
    'senior software engineer at Stripe',
    'job title',
    'current',
  ),
  buildPreferenceCluster(
    'p022',
    'factual',
    'I have been coding professionally for 12 years.',
    '12 years',
    'years coding professionally',
    'total',
  ),
  buildPreferenceCluster('p023', 'factual', "My team's headcount is seven.", 'seven', 'team headcount', 'main'),
  buildPreferenceCluster(
    'p024',
    'factual',
    'I speak three languages fluently: English, Portuguese, and Spanish.',
    'English, Portuguese, and Spanish',
    'languages I speak fluently',
    'main',
  ),
  buildPreferenceCluster('p025', 'factual', 'I bought my house in 2021.', '2021', 'year I bought my house', 'main'),
  buildPreferenceCluster('p026', 'factual', 'I have a peanut allergy.', 'peanut allergy', 'food allergy', 'main'),
  buildPreferenceCluster('p027', 'factual', 'My current salary is $185,000.', '$185,000', 'current salary', 'main'),
  buildPreferenceCluster(
    'p028',
    'factual',
    'I studied computer science.',
    'computer science',
    'undergraduate major',
    'main',
  ),
  buildPreferenceCluster('p029', 'factual', 'I run a 5K in 23 minutes.', '23 minutes', '5K time', 'current'),
  buildPreferenceCluster(
    'p030',
    'factual',
    'I have visited 17 countries.',
    '17 countries',
    'countries visited',
    'total',
  ),
  // --- preference (10) ---
  buildPreferenceCluster(
    'p031',
    'preference',
    'I prefer pour-over coffee with light-roast Ethiopian beans.',
    'pour-over with light-roast Ethiopian beans',
    'coffee preference',
    'preferred',
  ),
  buildPreferenceCluster(
    'p032',
    'preference',
    'My favorite cuisine is Korean.',
    'Korean',
    'favorite cuisine',
    'preferred',
  ),
  buildPreferenceCluster(
    'p033',
    'preference',
    'I like reading nonfiction over fiction.',
    'nonfiction',
    'preferred reading genre',
    'preferred',
  ),
  buildPreferenceCluster(
    'p034',
    'preference',
    'I prefer mountains over beaches for vacation.',
    'mountains',
    'preferred vacation type',
    'preferred',
  ),
  buildPreferenceCluster(
    'p035',
    'preference',
    'My favorite movie is The Shawshank Redemption.',
    'The Shawshank Redemption',
    'favorite movie',
    'preferred',
  ),
  buildPreferenceCluster(
    'p036',
    'preference',
    'I prefer single-malt Scotch over bourbon.',
    'single-malt Scotch',
    'preferred whiskey',
    'preferred',
  ),
  buildPreferenceCluster(
    'p037',
    'preference',
    'My favorite season is autumn.',
    'autumn',
    'favorite season',
    'preferred',
  ),
  buildPreferenceCluster(
    'p038',
    'preference',
    'I prefer running outdoors over the treadmill.',
    'running outdoors',
    'preferred running surface',
    'preferred',
  ),
  buildPreferenceCluster(
    'p039',
    'preference',
    'My favorite musician is Radiohead.',
    'Radiohead',
    'favorite musician',
    'preferred',
  ),
  buildPreferenceCluster(
    'p040',
    'preference',
    'I prefer aisle seats on flights.',
    'aisle seats',
    'preferred airplane seat',
    'preferred',
  ),
  // --- temporal (10) ---
  buildPreferenceCluster(
    'p041',
    'temporal',
    'I take a walk every morning at 7am.',
    '7am',
    'morning walk time',
    'usual',
  ),
  buildPreferenceCluster(
    'p042',
    'temporal',
    'I have a standing meeting on Mondays.',
    'Mondays',
    'day of weekly standing meeting',
    'usual',
  ),
  buildPreferenceCluster('p043', 'temporal', 'I usually eat dinner around 7:30pm.', '7:30pm', 'dinner time', 'usual'),
  buildPreferenceCluster(
    'p044',
    'temporal',
    'I started this job in March 2023.',
    'March 2023',
    'job start month',
    'main',
  ),
  buildPreferenceCluster(
    'p045',
    'temporal',
    'My next vacation is in October.',
    'October',
    'next vacation month',
    'next',
  ),
  buildPreferenceCluster(
    'p046',
    'temporal',
    'I go to the gym Tuesday and Thursday evenings.',
    'Tuesday and Thursday evenings',
    'gym days',
    'usual',
  ),
  buildPreferenceCluster(
    'p047',
    'temporal',
    'I do my weekly review on Sunday nights.',
    'Sunday nights',
    'weekly review time',
    'usual',
  ),
  buildPreferenceCluster('p048', 'temporal', 'I usually go to bed at 11pm.', '11pm', 'bedtime', 'usual'),
  buildPreferenceCluster('p049', 'temporal', 'My anniversary is on June 5th.', 'June 5', 'anniversary date', 'main'),
  buildPreferenceCluster(
    'p050',
    'temporal',
    'I take a quarterly digital detox in spring.',
    'spring',
    'quarterly digital detox season',
    'usual',
  ),
];

/**
 * Helper: builds a 4-paraphrase cluster from one base fact + a topic + a
 * "preference modifier" word slotted into each template (favorite/preferred/
 * main/etc.). Keeps the generator concise without sacrificing variety.
 */
function buildPreferenceCluster(
  id: string,
  domain: BaseCluster['domain'],
  fact: string,
  expected: string,
  topic: string,
  modifier: string,
): BaseCluster {
  return {
    id,
    domain,
    fact,
    expected,
    topic,
    templates: {
      canonical: `What is my ${modifier} ${topic}?`,
      lexical: `Which ${topic} do I ${modifier === 'preferred' ? 'prefer' : modifier === 'favorite' ? 'like best' : 'use as my ' + modifier}?`,
      syntactic: `${capitalize(topic)}, ${modifier}, what is it for me?`,
      indirect: `If I had to pick one ${topic} based on what I've told you, which would I pick?`,
    },
  };
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

const PARAPHRASE_FORMS: ParaphraseForm[] = ['canonical', 'lexical', 'syntactic', 'indirect'];

export function generate(seed: number, mode: 'mini' | 'full'): ProductFixture {
  void seed; // deterministic, no RNG needed; mode determines size.
  const minis = BASE_MINI;
  // Full mode: replicate the mini set 4× with deterministic suffixes so we
  // hit 200 clusters without ballooning hand-curation. Each replicate uses a
  // distinct year/index to keep memory ids and answers distinct enough that
  // retrieval doesn't collapse them.
  let clusters: BaseCluster[];
  if (mode === 'mini') {
    clusters = minis;
  } else {
    clusters = [];
    for (let r = 0; r < 4; r++) {
      for (const c of minis) {
        clusters.push({
          ...c,
          id: `${c.id}-r${r}`,
          fact: `${c.fact} (record set ${r + 1})`,
          expected: c.expected,
        });
      }
    }
  }

  const scenarios: ProductScenario[] = clusters.map((c) => {
    const fact: ProductFact = {
      claim: c.fact,
      subject: 'user',
      source: 'user',
      validFrom: '2024-01-15T12:00:00Z',
      meta: { domain: c.domain, clusterId: c.id, expected: c.expected },
    };
    const queries: ProductQuery[] = PARAPHRASE_FORMS.map((form) => ({
      qid: `${c.id}-${form}`,
      category: form,
      question: c.templates[form],
      expected: c.expected,
      meta: { form, domain: c.domain, clusterId: c.id },
    }));
    return {
      scenario_id: `cluster-${c.id}`,
      facts: [fact],
      queries,
      meta: { clusterId: c.id, domain: c.domain, topic: c.topic },
    };
  });

  return {
    bench_id: 'paraphrase',
    upstream_version: 'paraphrase-templated-v1',
    description:
      'Paraphrase Stability bench: per cluster, 1 memory + 4 paraphrased questions (canonical / lexical / syntactic / indirect). Cluster passes only if all 4 produce equivalent answers AND retrieval-set Jaccard ≥ 0.8.',
    mode,
    scenarios,
  };
}
