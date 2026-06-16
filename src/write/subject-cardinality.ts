/**
 * Subject cardinality registry for supersession gating.
 *
 * Demiurge stores facts as (subject, claim) where `subject` is the attribute
 * category the extractor assigns (e.g. "location", "occupation", "languages").
 * Supersession is only correct for SINGLE-VALUED subjects: attributes with at
 * most one current value per user. A new value supersedes the old one
 * (recency wins): a new "location" replaces the prior "location".
 *
 * MULTI-VALUED (additive) subjects accumulate: "languages", "hobbies", "likes".
 * A new value must NEVER supersede an existing one ("speaks Spanish" must not
 * replace "speaks English").
 *
 * Refusal-first default: a subject NOT listed here is treated as MULTI-VALUED.
 * The safe error is keeping a stale fact (false negative), never destroying a
 * valid one (false positive). Promote a subject to single-valued only when it
 * is genuinely one value per user. Expand SINGLE_VALUED_SUBJECTS as new
 * single-valued attributes show up in real data (human gated).
 */

// L3 interaction-pref dimensions (S80). One current value per dimension per
// user, so a new preference supersedes the old (verbose -> concise). The
// steering layer (P3) reads these back via getBySubject to shape host behavior.
export const INTERACTION_DIMENSIONS = [
  'verbosity',
  'tone',
  'response_format',
  'technical_depth',
  'preferred_language',
  'units',
] as const;

// Canonical single-valued attribute keys (one current value per user).
const SINGLE_VALUED_SUBJECTS = new Set<string>([
  'location',
  'occupation',
  'employer',
  'job_title',
  'age',
  'birthday',
  'income',
  'salary',
  'marital_status',
  'relationship_status',
  'name',
  'phone',
  'phone_number',
  'address',
  'email',
  'height',
  'weight',
  'nationality',
  'current_role',
  'current_project',
  'timezone',
  'pronouns',
  ...INTERACTION_DIMENSIONS,
]);

// Surface variants and synonyms mapped to a canonical single-valued key. Keep
// this small and high precision. Anything unmapped falls through to the
// multi-valued default.
const SUBJECT_SYNONYMS: Record<string, string> = {
  city: 'location',
  hometown: 'location',
  residence: 'location',
  'home location': 'location',
  'current location': 'location',
  lives: 'location',
  job: 'occupation',
  work: 'occupation',
  profession: 'occupation',
  career: 'occupation',
  company: 'employer',
  'current employer': 'employer',
  title: 'job_title',
  role: 'current_role',
  earnings: 'income',
  'phone number': 'phone_number',
  'email address': 'email',
  'date of birth': 'birthday',
  dob: 'birthday',
  spouse: 'marital_status',
  married: 'marital_status',
};

/**
 * Normalize a raw subject string to a canonical key for cardinality lookup.
 * Lowercase, trim, strip a leading possessive or article, collapse whitespace,
 * then apply synonyms. Falls back to a space-to-underscore form so multi word
 * subjects like "job title" match the underscored canonical key "job_title".
 */
export function normalizeSubject(subject: string): string {
  let s = subject.toLowerCase().trim();
  // Strip a leading possessive or article: "user's location" becomes "location".
  s = s.replace(/^(the\s+|a\s+|user'?s?\s+|my\s+|their\s+)/, '').trim();
  // Collapse internal whitespace.
  s = s.replace(/\s+/g, ' ');
  const synonym = SUBJECT_SYNONYMS[s];
  if (synonym) return synonym;
  return s.replace(/ /g, '_');
}

/**
 * True when the subject is single-valued (supersedable). Multi-valued and
 * unknown subjects return false (additive, never supersede). This gate prevents
 * lexical-Jaccard over-supersession from destroying multi-valued facts.
 */
export function isSingleValuedSubject(subject: string): boolean {
  if (!subject) return false;
  return SINGLE_VALUED_SUBJECTS.has(normalizeSubject(subject));
}
