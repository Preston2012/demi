import type { CompiledMemory } from '../schema/memory.js';

/**
 * U7: Timeline construction for temporal queries.
 *
 * Error taxonomy: 10 of 18 reasoning errors were temporal confusion.
 * Root cause: dates scattered across subject-grouped facts.
 * Fix: extract event dates from claims, sort chronologically,
 * format as a visible timeline the answer model can scan.
 *
 * Only used when query is classified as temporal.
 */

interface DatedMemory {
  memory: CompiledMemory;
  date: Date;
  dateStr: string;
  memId: number;
}

/**
 * Extract a date from a claim string.
 * Returns the first date found, or null.
 */
export function extractDateFromClaim(claim: string): { date: Date; dateStr: string } | null {
  // Pattern 0: ISO date "2022-05-08" (also matches "on 2022-05-08", the
  // canonical form temporal-parse-ir emits for resolved relative phrases).
  // Most specific, so checked first. Fix #7: timeline.ts was ISO-blind, so
  // ISO-dated facts (LOCOMO/BEAM and all resolved relatives) never reached
  // the temporal timeline injection.
  const isoDate = claim.match(/([0-9]{4})-([0-9]{2})-([0-9]{2})/);
  if (isoDate) {
    const y = Number(isoDate[1]);
    const mo = Number(isoDate[2]);
    const da = Number(isoDate[3]);
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      const d = new Date(y, mo - 1, da);
      if (!isNaN(d.getTime())) return { date: d, dateStr: isoDate[1] + '-' + isoDate[2] + '-' + isoDate[3] };
    }
  }

  // Pattern 1: "7 May 2023" or "7 May, 2023"
  const dmy = claim.match(
    /(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December),?\s+(\d{4})/i,
  );
  if (dmy) {
    const d = new Date(dmy[2] + ' ' + dmy[1] + ', ' + dmy[3]);
    if (!isNaN(d.getTime())) return { date: d, dateStr: dmy[1] + ' ' + dmy[2] + ' ' + dmy[3] };
  }

  // Pattern 2: "May 7, 2023"
  const mdy = claim.match(
    /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i,
  );
  if (mdy) {
    const d = new Date(mdy[1] + ' ' + mdy[2] + ', ' + mdy[3]);
    if (!isNaN(d.getTime())) return { date: d, dateStr: mdy[2] + ' ' + mdy[1] + ' ' + mdy[3] };
  }

  // Pattern 3: "June 2023" (month + year, no day)
  const my = claim.match(
    /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i,
  );
  if (my) {
    const d = new Date(my[1] + ' 1, ' + my[2]);
    if (!isNaN(d.getTime())) return { date: d, dateStr: my[1] + ' ' + my[2] };
  }

  // Pattern 4: standalone year "in 2022"
  const yr = claim.match(/\bin\s+(\d{4})\b/);
  if (yr) {
    const d = new Date('January 1, ' + yr[1]);
    if (!isNaN(d.getTime())) return { date: d, dateStr: yr[1]! };
  }

  return null;
}

/**
 * Build a chronological timeline from injected memories.
 * Only includes memories with extractable dates.
 */
export function buildTimeline(
  memories: CompiledMemory[],
  memIdOffset: number = 1,
): { timeline: string; datedCount: number } {
  const dated: DatedMemory[] = [];

  for (let i = 0; i < memories.length; i++) {
    const m = memories[i]!;
    const extracted = extractDateFromClaim(m.claim);
    if (extracted) {
      dated.push({
        memory: m,
        date: extracted.date,
        dateStr: extracted.dateStr,
        memId: memIdOffset + i,
      });
    }
  }

  if (dated.length === 0) {
    return { timeline: '', datedCount: 0 };
  }

  dated.sort((a, b) => a.date.getTime() - b.date.getTime());

  const lines: string[] = [];
  lines.push('[Timeline: ' + dated.length + ' dated events]');

  let lastDateStr = '';
  for (const d of dated) {
    const prefix = d.dateStr === lastDateStr ? '  ' : '[' + d.dateStr + ']';
    lines.push(prefix + ' [M' + d.memId + '] ' + d.memory.subject + ': ' + d.memory.claim);
    lastDateStr = d.dateStr;
  }

  return { timeline: lines.join('\n'), datedCount: dated.length };
}
