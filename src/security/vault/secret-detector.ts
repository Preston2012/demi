import { SECRET_PATTERNS, type SecretPattern } from './patterns.js';
import type { DetectedSecret, SecretDetectionResult } from './types.js';

/**
 * Pure regex-based secret detection. No vault access, no side effects.
 *
 * Mirrors the shape of `detectInjection` in src/write/validators.ts:
 * iterate the pattern table, collect spans, return the redacted form.
 *
 * The caller (materializer Position 1, inject Position 2) decides what
 * to do with the spans, Position 1 encrypts and substitutes refs,
 * Position 2 just redacts on the fly with loud telemetry.
 */
export function detectSecretsInText(text: string): SecretDetectionResult {
  const spans: DetectedSecret[] = [];
  for (const def of SECRET_PATTERNS) {
    collectMatches(text, def, spans);
  }
  // Resolve overlaps: keep the earliest-start, longest-span winners.
  spans.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const nonOverlapping: DetectedSecret[] = [];
  let cursor = -1;
  for (const s of spans) {
    if (s.start >= cursor) {
      nonOverlapping.push(s);
      cursor = s.end;
    }
  }
  return {
    spans: nonOverlapping,
    redactedText: redact(text, nonOverlapping),
    hasSecrets: nonOverlapping.length > 0,
  };
}

function collectMatches(text: string, def: SecretPattern, out: DetectedSecret[]): void {
  const re = new RegExp(
    def.pattern.source,
    def.pattern.flags.includes('g') ? def.pattern.flags : def.pattern.flags + 'g',
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // For patterns with a capturing group, the secret value is group 1; else full match.
    const value = m[1] ?? m[0];
    if (def.validate && !def.validate(value)) continue;
    // If the capture group exists, locate it within the full match.
    const start = m[1] !== undefined ? m.index + m[0].indexOf(m[1]) : m.index;
    const end = start + value.length;
    out.push({ pattern: def.name, start, end, value });
    if (re.lastIndex === m.index) re.lastIndex++; // guard against zero-width loops
  }
}

function redact(text: string, spans: DetectedSecret[]): string {
  if (spans.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const s of spans) {
    out += text.slice(cursor, s.start);
    out += `[SECRET:${s.pattern}]`;
    cursor = s.end;
  }
  out += text.slice(cursor);
  return out;
}
