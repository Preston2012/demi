import { extractEntities } from './ir.js';
/**
 * Temporal specialist.
 *
 * Targets: LME temporal-reasoning (20 pts), BEAM event_ordering (6 pts),
 * LOCOMO temporal (5.7 pts). ~32 pts total recoverable.
 *
 * Council R16 rulings applied:
 *   - Build query-aware temporal table, not just adjacent gaps (Grok)
 *   - Support sort, before/after, interval(A,B), latest, earliest (Grok)
 *   - Timeline rows retain evidence quote + memory_id (GPT)
 *   - Augment don't replace (4/4 unanimous)
 *   - Full pairwise + question-aware interval selection (Grok)
 *
 * Operations: sort, interval computation, event ordering, recency detection.
 * Deterministic: no LLM calls. O(n log n) sort + O(n) interval computation.
 */

import type { QueryType } from '../retrieval/query-classifier.js';
import type { NormalizedFact, RequiredOperations, SpecialistOutput } from './types.js';

// ---------------------------------------------------------------------------
// Temporal Event
// ---------------------------------------------------------------------------

interface TemporalEvent {
  memoryId: string;
  subject: string;
  date: string;          // ISO date
  dateMs: number;        // epoch ms for arithmetic
  description: string;   // short evidence quote
  factIndex: number;     // position in facts array
}

// ---------------------------------------------------------------------------
// Date Utilities
// ---------------------------------------------------------------------------

function parseToMs(isoDate: string): number {
  const d = new Date(isoDate);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function daysBetween(ms1: number, ms2: number): number {
  return Math.round(Math.abs(ms2 - ms1) / (1000 * 60 * 60 * 24));
}

function weeksBetween(ms1: number, ms2: number): number {
  return Math.round(daysBetween(ms1, ms2) / 7 * 10) / 10;
}

function monthsBetween(ms1: number, ms2: number): number {
  return Math.round(daysBetween(ms1, ms2) / 30.44 * 10) / 10;
}

function formatDate(isoDate: string): string {
  try {
    const d = new Date(isoDate);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return isoDate;
  }
}

// ---------------------------------------------------------------------------
// Query Analysis
// ---------------------------------------------------------------------------

interface TemporalQueryInfo {
  asksOrder: boolean;        // "what order", "which first", "sequence"
  asksInterval: boolean;     // "how many days/weeks between"
  asksLatest: boolean;       // "most recent", "last time"
  asksEarliest: boolean;     // "first time", "when did X start"
  intervalUnit: 'days' | 'weeks' | 'months' | null;
  subjectFilter: string[];   // entities mentioned in query
}

function analyzeTemporalQuery(query: string): TemporalQueryInfo {
  const q = query.toLowerCase();
  return {
    asksOrder: /\b(order|sequence|first.*second|before.*after|which.*first|who.*first|earliest.*latest|chronolog)\b/.test(q),
    asksInterval: /\b(how (?:many|long|much time)|between|gap|interval|passed|elapsed|span)\b/.test(q),
    asksLatest: /\b(most recent|latest|last time|last|current|now)\b/.test(q),
    asksEarliest: /\b(first time|first|earliest|when did.*start|when did.*begin|original)\b/.test(q),
    intervalUnit: /\bdays?\b/.test(q) ? 'days' : /\bweeks?\b/.test(q) ? 'weeks' : /\bmonths?\b/.test(q) ? 'months' : null,
    subjectFilter: extractQuerySubjects(query),
  };
}

function extractQuerySubjects(query: string): string[] {
  // Extract capitalized names as potential subject filters
  const names = extractEntities(query);
  return names ? [...new Set(names)] : [];
}

// ---------------------------------------------------------------------------
// Temporal Specialist
// ---------------------------------------------------------------------------

export const temporalSpecialist = {
  name: 'temporal',

  shouldRun(ops: RequiredOperations): boolean {
    return ops.resolveTime;
  },

  process(facts: NormalizedFact[], query: string, _queryType: QueryType): SpecialistOutput {
    const qInfo = analyzeTemporalQuery(query);

    // Step 1: Extract temporal events from facts with dates
    const events: TemporalEvent[] = [];
    for (let i = 0; i < facts.length; i++) {
      const fact = facts[i]!;
      if (!fact.time) continue;

      const dateMs = parseToMs(fact.time);
      if (dateMs === 0) continue;

      // S27 fix #9: subject filter now active (was empty if-block)
      // Skip facts that don't match query subjects. Fallback to unfiltered if empty.
      if (qInfo.subjectFilter.length > 0) {
        const matchesSubject = qInfo.subjectFilter.some(
          s => fact.subject.toLowerCase().includes(s.toLowerCase())
        );
        if (!matchesSubject) continue;
      }

      events.push({
        memoryId: fact.memoryId,
        subject: fact.subject,
        date: fact.time,
        dateMs,
        description: fact.sourceText.length > 120
          ? fact.sourceText.substring(0, 120) + '...'
          : fact.sourceText,
        factIndex: i,
      });
    }

    if (events.length === 0) {
      return {
        source: 'temporal',
        derivedEvidence: '[TEMPORAL] No datable events found in memories.',
        factsUsed: [],
        processingMs: 0,
      };
    }

    // Step 2: Sort chronologically
    events.sort((a, b) => a.dateMs - b.dateMs);

    // Step 3: Build derived evidence based on query needs
    const lines: string[] = [];
    const factsUsed: string[] = events.map(e => e.memoryId);

    // Always: chronological timeline
    lines.push(`TIMELINE (${events.length} events, sorted):`);
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      const prefix = `  ${i + 1}. [${formatDate(ev.date)}]`;
      lines.push(`${prefix} ${ev.subject}: ${ev.description} (${ev.memoryId})`);

      // Adjacent interval
      if (i > 0) {
        const prev = events[i - 1]!;
        const gap = daysBetween(prev.dateMs, ev.dateMs);
        if (gap > 0) {
          lines.push(`     ^ ${gap} days after previous event`);
        }
      }
    }

    // If asking about intervals, compute specific ones
    if (qInfo.asksInterval && events.length >= 2) {
      lines.push('');
      lines.push('INTERVALS:');
      const first = events[0]!;
      const last = events[events.length - 1]!;
      const totalDays = daysBetween(first.dateMs, last.dateMs);

      lines.push(`  Total span: ${totalDays} days (${weeksBetween(first.dateMs, last.dateMs)} weeks, ${monthsBetween(first.dateMs, last.dateMs)} months)`);
      lines.push(`  Earliest: ${formatDate(first.date)} (${first.subject})`);
      lines.push(`  Latest: ${formatDate(last.date)} (${last.subject})`);

      // Pairwise intervals for key events (limit to avoid O(n^2) explosion)
      if (events.length <= 15) {
        lines.push('  Key intervals:');
        for (let i = 0; i < events.length; i++) {
          for (let j = i + 1; j < events.length; j++) {
            const a = events[i]!;
            const b = events[j]!;
            const gap = daysBetween(a.dateMs, b.dateMs);
            if (gap > 0) {
              const unit = qInfo.intervalUnit || 'days';
              let val: string;
              if (unit === 'weeks') val = `${weeksBetween(a.dateMs, b.dateMs)} weeks`;
              else if (unit === 'months') val = `${monthsBetween(a.dateMs, b.dateMs)} months`;
              else val = `${gap} days`;
              lines.push(`    ${a.subject} (${a.date}) → ${b.subject} (${b.date}): ${val}`);
            }
          }
        }
      }
    }

    // If asking about order
    if (qInfo.asksOrder) {
      lines.push('');
      lines.push('CHRONOLOGICAL ORDER:');
      for (let i = 0; i < events.length; i++) {
        const ev = events[i]!;
        const ordinal = i === 0 ? 'First' : i === events.length - 1 ? 'Last' : `${i + 1}th`;
        lines.push(`  ${ordinal}: ${ev.subject} - ${ev.date} (${ev.memoryId})`);
      }
    }

    // If asking about latest
    if (qInfo.asksLatest && events.length > 0) {
      const latest = events[events.length - 1]!;
      lines.push('');
      lines.push(`MOST RECENT: ${latest.subject} on ${formatDate(latest.date)} - ${latest.description} (${latest.memoryId})`);
    }

    // If asking about earliest
    if (qInfo.asksEarliest && events.length > 0) {
      const earliest = events[0]!;
      lines.push('');
      lines.push(`EARLIEST: ${earliest.subject} on ${formatDate(earliest.date)} - ${earliest.description} (${earliest.memoryId})`);
    }

    return {
      source: 'temporal',
      derivedEvidence: lines.join('\n'),
      factsUsed,
      processingMs: 0, // set by pipeline
    };
  },
};
