/**
 * Temporal normalization for injection claims.
 *
 * Replaces relative time references ("last year", "yesterday", "last week")
 * with absolute dates derived from the memory's validFrom timestamp.
 *
 * Addresses 4/16 fragile temporal questions from S16 judge diff.
 * Feature flag: TEMPORAL_NORMALIZE (default: false, opt-in)
 */

import type { CompiledMemory } from '../schema/memory.js';

const RELATIVE_PATTERNS: Array<{
  regex: RegExp;
  resolver: (validFrom: Date) => string;
}> = [
  {
    regex: /\byesterday\b/gi,
    resolver: (d) => {
      const prev = new Date(d);
      prev.setDate(prev.getDate() - 1);
      return 'on ' + formatDate(prev);
    },
  },
  {
    regex: /\blast week\b/gi,
    resolver: (d) => {
      const prev = new Date(d);
      prev.setDate(prev.getDate() - 7);
      return 'the week of ' + formatDate(prev);
    },
  },
  {
    regex: /\blast month\b/gi,
    resolver: (d) => {
      const prev = new Date(d);
      prev.setMonth(prev.getMonth() - 1);
      return 'in ' + formatMonth(prev);
    },
  },
  {
    regex: /\blast year\b/gi,
    resolver: (d) => {
      return 'in ' + (d.getFullYear() - 1);
    },
  },
  {
    regex: /\blast summer\b/gi,
    resolver: (d) => {
      return 'in summer ' + (d.getFullYear() - (d.getMonth() < 6 ? 1 : 0));
    },
  },
  {
    regex: /\blast spring\b/gi,
    resolver: (d) => {
      return 'in spring ' + (d.getFullYear() - (d.getMonth() < 3 ? 1 : 0));
    },
  },
  {
    regex: /\blast winter\b/gi,
    resolver: (d) => {
      return 'in winter ' + (d.getFullYear() - (d.getMonth() < 12 ? 0 : 1));
    },
  },
  {
    regex: /\blast fall\b/gi,
    resolver: (d) => {
      return 'in fall ' + (d.getFullYear() - (d.getMonth() < 9 ? 1 : 0));
    },
  },
  {
    regex: /\blast Sunday\b/gi,
    resolver: (d) => {
      const prev = new Date(d);
      const day = prev.getDay();
      prev.setDate(prev.getDate() - (day === 0 ? 7 : day));
      return 'on Sunday ' + formatDate(prev);
    },
  },
  {
    regex: /\blast Friday\b/gi,
    resolver: (d) => {
      const prev = new Date(d);
      const day = prev.getDay();
      const diff = day >= 5 ? day - 5 : day + 2;
      prev.setDate(prev.getDate() - diff);
      return 'on Friday ' + formatDate(prev);
    },
  },
  {
    regex: /\brecently\b/gi,
    resolver: (d) => 'around ' + formatDate(d),
  },
  {
    regex: /\blast Tuesday\b/gi,
    resolver: (d) => {
      const prev = new Date(d);
      const day = prev.getDay();
      const diff = day >= 2 ? day - 2 : day + 5;
      prev.setDate(prev.getDate() - diff);
      return 'on Tuesday ' + formatDate(prev);
    },
  },
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function formatDate(d: Date): string {
  return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}

function formatMonth(d: Date): string {
  return MONTHS[d.getMonth()] + ' ' + d.getFullYear();
}

/**
 * Normalize relative time references in a claim to absolute dates.
 * Returns the original claim if no validFrom is available or no patterns match.
 */
export function normalizeTemporal(claim: string, validFrom: string | null): string {
  if (!validFrom) return claim;
  if (process.env.TEMPORAL_NORMALIZE !== 'true') return claim;

  const date = new Date(validFrom);
  if (isNaN(date.getTime())) return claim;

  let result = claim;
  for (const pattern of RELATIVE_PATTERNS) {
    if (pattern.regex.test(result)) {
      const replacement = pattern.resolver(date);
      result = result.replace(pattern.regex, replacement);
    }
  }
  return result;
}

/**
 * Apply temporal normalization to all memories in a list.
 */
export function normalizeTemporalAll(memories: CompiledMemory[]): CompiledMemory[] {
  return memories.map(m => ({
    ...m,
    claim: normalizeTemporal(m.claim, m.createdAt),
  }));
}
