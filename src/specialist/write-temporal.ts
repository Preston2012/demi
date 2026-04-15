/**
 * Write-time temporal normalization.
 *
 * Normalizes date references in memory claims at ingestion time,
 * BEFORE they're stored. This makes read-time temporal specialist
 * trivially reliable (just sort ISO dates) instead of regex-fragile.
 *
 * Council R16 (Gemini + CI):
 *   "Shift temporal extraction to the ingestion phase. Parse and normalize
 *    all temporal references into standard ISO timestamps using deterministic
 *    rules at the time the memory is saved."
 *
 * Handles:
 *   - Explicit dates: "March 5, 2023" -> already ISO-friendly
 *   - Month-year: "in May 2023" -> validFrom = 2023-05-01
 *   - Relative with anchor: "last Tuesday" (needs ingestion timestamp as anchor)
 *   - Season references: "last summer" -> approximate range
 *
 * Output: Populates validFrom/validTo fields on the memory record.
 * Does NOT modify the claim text (preserves original wording).
 *
 * Flag: WRITE_TIME_TEMPORAL=true
 */

import { extractDate as _extractDate, extractAllDates } from './ir.js';

// ---------------------------------------------------------------------------
// Relative Date Resolution
// ---------------------------------------------------------------------------

const DAY_NAMES: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

const SEASON_RANGES: Record<string, { startMonth: number; endMonth: number }> = {
  spring: { startMonth: 3, endMonth: 5 },
  summer: { startMonth: 6, endMonth: 8 },
  fall: { startMonth: 9, endMonth: 11 },
  autumn: { startMonth: 9, endMonth: 11 },
  winter: { startMonth: 12, endMonth: 2 },
};

interface TemporalResult {
  validFrom: string | null;  // ISO date
  validTo: string | null;    // ISO date (for ranges)
  confidence: 'exact' | 'approximate' | 'inferred';
}

/**
 * Resolve a relative date expression against an anchor date.
 */
function resolveRelativeDate(text: string, anchor: Date): TemporalResult | null {
  const lower = text.toLowerCase();

  // "yesterday"
  if (/\byesterday\b/.test(lower)) {
    const d = new Date(anchor);
    d.setDate(d.getDate() - 1);
    return { validFrom: d.toISOString().substring(0, 10), validTo: null, confidence: 'exact' };
  }

  // "today"
  if (/\btoday\b/.test(lower)) {
    return { validFrom: anchor.toISOString().substring(0, 10), validTo: null, confidence: 'exact' };
  }

  // "last [day]" e.g., "last Tuesday"
  const lastDayMatch = lower.match(/\blast\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (lastDayMatch) {
    const targetDay = DAY_NAMES[lastDayMatch[1]!]!;
    const d = new Date(anchor);
    const currentDay = d.getDay();
    let diff = currentDay - targetDay;
    if (diff <= 0) diff += 7;
    d.setDate(d.getDate() - diff);
    return { validFrom: d.toISOString().substring(0, 10), validTo: null, confidence: 'approximate' };
  }

  // "N days/weeks/months ago"
  const agoMatch = lower.match(/(\d+)\s+(days?|weeks?|months?|years?)\s+ago/);
  if (agoMatch) {
    const n = parseInt(agoMatch[1]!, 10);
    const unit = agoMatch[2]!;
    const d = new Date(anchor);
    if (unit.startsWith('day')) d.setDate(d.getDate() - n);
    else if (unit.startsWith('week')) d.setDate(d.getDate() - n * 7);
    else if (unit.startsWith('month')) d.setMonth(d.getMonth() - n);
    else if (unit.startsWith('year')) d.setFullYear(d.getFullYear() - n);
    return { validFrom: d.toISOString().substring(0, 10), validTo: null, confidence: 'approximate' };
  }

  // "a week/month/year ago"
  const singleAgoMatch = lower.match(/\ba\s+(week|month|year)\s+ago\b/);
  if (singleAgoMatch) {
    const unit = singleAgoMatch[1]!;
    const d = new Date(anchor);
    if (unit === 'week') d.setDate(d.getDate() - 7);
    else if (unit === 'month') d.setMonth(d.getMonth() - 1);
    else if (unit === 'year') d.setFullYear(d.getFullYear() - 1);
    return { validFrom: d.toISOString().substring(0, 10), validTo: null, confidence: 'approximate' };
  }

  // "last week/month/year"
  const lastPeriodMatch = lower.match(/\blast\s+(week|month|year)\b/);
  if (lastPeriodMatch) {
    const unit = lastPeriodMatch[1]!;
    const start = new Date(anchor);
    const end = new Date(anchor);
    if (unit === 'week') {
      start.setDate(start.getDate() - 7 - start.getDay());
      end.setDate(start.getDate() + 6);
    } else if (unit === 'month') {
      start.setMonth(start.getMonth() - 1, 1);
      end.setMonth(start.getMonth() + 1, 0);
    } else if (unit === 'year') {
      start.setFullYear(start.getFullYear() - 1, 0, 1);
      end.setFullYear(start.getFullYear(), 11, 31);
    }
    return {
      validFrom: start.toISOString().substring(0, 10),
      validTo: end.toISOString().substring(0, 10),
      confidence: 'approximate',
    };
  }

  // "last summer/winter/spring/fall"
  const seasonMatch = lower.match(/\blast\s+(spring|summer|fall|autumn|winter)\b/);
  if (seasonMatch) {
    const season = SEASON_RANGES[seasonMatch[1]!]!;
    const year = anchor.getMonth() >= season.startMonth
      ? anchor.getFullYear()
      : anchor.getFullYear() - 1;
    const startYear = season.startMonth === 12 ? year - 1 : year;
    return {
      validFrom: `${startYear}-${String(season.startMonth).padStart(2, '0')}-01`,
      validTo: `${year}-${String(season.endMonth).padStart(2, '0')}-28`,
      confidence: 'approximate',
    };
  }

  // "the following [day]", "the next [day]" (relative to a previously mentioned date)
  // These require context from the conversation, which we don't have here.
  // Mark as inferred with null dates for now.

  return null;
}

// ---------------------------------------------------------------------------
// Main Normalizer
// ---------------------------------------------------------------------------

/**
 * Normalize temporal references in a memory claim.
 *
 * @param claim - The memory claim text
 * @param ingestionTime - When the memory was ingested (anchor for relative dates)
 * @param existingValidFrom - Already-set validFrom (from user or extraction)
 * @param existingValidTo - Already-set validTo
 * @returns Updated validFrom/validTo, or null if no temporal info found
 */
export function normalizeTemporalAtWrite(
  claim: string,
  ingestionTime: Date,
  existingValidFrom?: string | null,
  existingValidTo?: string | null,
): TemporalResult | null {
  // If validFrom is already set with an ISO date, don't override
  if (existingValidFrom && /^\d{4}-\d{2}-\d{2}/.test(existingValidFrom)) {
    return {
      validFrom: existingValidFrom,
      validTo: existingValidTo || null,
      confidence: 'exact',
    };
  }

  // Try explicit date extraction first (most reliable)
  const explicitDates = extractAllDates(claim);
  if (explicitDates.length > 0) {
    const sorted = explicitDates.sort();
    return {
      validFrom: sorted[0]!,
      validTo: sorted.length > 1 ? sorted[sorted.length - 1]! : null,
      confidence: 'exact',
    };
  }

  // Try relative date resolution
  const relative = resolveRelativeDate(claim, ingestionTime);
  if (relative) return relative;

  // No temporal information found
  return null;
}

/**
 * Check if write-time temporal normalization is enabled.
 */
export function isWriteTimeTemporalEnabled(): boolean {
  return process.env.WRITE_TIME_TEMPORAL === 'true';
}
