/**
 * S59 / TEMPR, query-time date-bounds extractor.
 *
 * Extracts an absolute or bounded date range from a query string. Drives:
 *   1. searchTemporalRange() candidate gathering (filters memories by date overlap).
 *   2. The rerank α floor, when a query has an explicit date but the
 *      query-classifier flags it as "timeless" (α=0), the recency boost
 *      floor lifts to default-recency (0.2). Never pushes α above the
 *      query-type ceiling.
 *
 * Uses chrono-node for parsing, battle-tested coverage of relative refs,
 * weekday-anchored phrases, ISO dates, partial dates, and ranges. Adds a
 * small "before/after/since" pre-scan for unbounded prefix handling, since
 * chrono returns the parsed date as a point and we need open intervals.
 */

import * as chrono from 'chrono-node';

export type DateGranularity = 'day' | 'month' | 'year' | 'relative';

export interface DateBounds {
  from?: Date;
  to?: Date;
  /** True when bound is precise enough (day or month) to anchor an episode. */
  episodeSignal: boolean;
  granularity: DateGranularity;
}

const BEFORE_RE = /\b(before|prior to|earlier than|until)\s+/i;
const AFTER_RE = /\b(after|since|from|starting)\s+/i;

const YEAR_ONLY_RE = /\b(?:in|during|of)\s+(\d{4})\b|\b(\d{4})s?\b/;

export function extractDateBounds(query: string, nowIso: string): DateBounds | null {
  const refDate = new Date(nowIso);
  const results = chrono.parse(query, refDate, { forwardDate: false });
  if (results.length === 0) {
    // Chrono misses naked 4-digit years like "in 2024" or "2024". Fall back
    // to a regex; expand to full-year bounds at year granularity.
    const m = query.match(YEAR_ONLY_RE);
    if (m) {
      const year = parseInt(m[1] ?? m[2]!, 10);
      if (year >= 1900 && year <= 2200) {
        const from = new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0));
        const to = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
        return { from, to, granularity: 'year', episodeSignal: false };
      }
    }
    return null;
  }

  // Granularity from the first result's start components. Day > month > year.
  const first = results[0]!;
  let granularity: DateGranularity;
  if (first.start.isCertain('day')) granularity = 'day';
  else if (first.start.isCertain('month')) granularity = 'month';
  else if (first.start.isCertain('year')) granularity = 'year';
  else granularity = 'relative';

  // If chrono returned a range (start + end), use it directly.
  // Else expand the point to a bound based on granularity.
  let from: Date | undefined;
  let to: Date | undefined;

  if (results.length >= 2) {
    // Multiple parsed dates, span them.
    const dates = results.map((r) => r.start.date()).sort((a, b) => a.getTime() - b.getTime());
    from = dates[0];
    to = dates[dates.length - 1];
  } else if (first.end) {
    from = first.start.date();
    to = first.end.date();
  } else {
    const point = first.start.date();
    from = point;
    to = expandToEnd(point, granularity);
  }

  // Unbounded-prefix handling: "before X" → from=undefined; "after X" → to=undefined.
  // Only applies when the prefix appears immediately before the parsed text.
  const matchedText = first.text;
  const matchIdx = query.indexOf(matchedText);
  const lead = matchIdx >= 0 ? query.slice(0, matchIdx) : '';
  if (BEFORE_RE.test(lead)) {
    from = undefined;
  } else if (AFTER_RE.test(lead)) {
    to = undefined;
  }

  return {
    from,
    to,
    granularity,
    episodeSignal: granularity === 'day' || granularity === 'month',
  };
}

function expandToEnd(point: Date, granularity: DateGranularity): Date {
  const end = new Date(point.getTime());
  if (granularity === 'day') {
    end.setUTCHours(23, 59, 59, 999);
  } else if (granularity === 'month') {
    end.setUTCMonth(end.getUTCMonth() + 1, 0);
    end.setUTCHours(23, 59, 59, 999);
  } else if (granularity === 'year') {
    end.setUTCMonth(11, 31);
    end.setUTCHours(23, 59, 59, 999);
  }
  return end;
}
