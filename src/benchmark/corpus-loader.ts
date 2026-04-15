import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BenchmarkCorpus } from './types.js';

/**
 * Load a benchmark corpus from a JSON fixture file.
 */
export function loadCorpus(fixturesDir: string, corpusName: string): BenchmarkCorpus {
  const path = resolve(fixturesDir, `${corpusName}.json`);
  if (!existsSync(path)) {
    throw new Error(`Corpus not found: ${path}`);
  }

  const raw = readFileSync(path, 'utf-8');
  const corpus: BenchmarkCorpus = JSON.parse(raw);

  if (!corpus.conversations?.length) {
    throw new Error(`Corpus ${corpusName} has no conversations`);
  }
  if (!corpus.questions?.length) {
    throw new Error(`Corpus ${corpusName} has no questions`);
  }

  return corpus;
}
