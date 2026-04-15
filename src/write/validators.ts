/**
 * Deterministic validators for the write pipeline.
 * Zero LLM calls. Pure pattern matching + heuristics.
 *
 * Run BEFORE trust branching. Failures here → REJECT branch.
 * Order: format → content → injection.
 */

// --- Format validation ---

const MIN_CLAIM_LENGTH = 5;
const MAX_CLAIM_LENGTH = 2000;
const MIN_SUBJECT_LENGTH = 1;
const MAX_SUBJECT_LENGTH = 500;

export interface ValidationResult {
  valid: boolean;
  reason: string | null;
}

export function validateFormat(claim: string, subject?: string): ValidationResult {
  if (!claim || claim.trim().length < MIN_CLAIM_LENGTH) {
    return {
      valid: false,
      reason: `Claim too short (min ${MIN_CLAIM_LENGTH} chars)`,
    };
  }

  if (claim.length > MAX_CLAIM_LENGTH) {
    return {
      valid: false,
      reason: `Claim too long (max ${MAX_CLAIM_LENGTH} chars)`,
    };
  }

  if (subject !== undefined) {
    if (subject.trim().length < MIN_SUBJECT_LENGTH) {
      return { valid: false, reason: 'Subject cannot be empty' };
    }
    if (subject.length > MAX_SUBJECT_LENGTH) {
      return {
        valid: false,
        reason: `Subject too long (max ${MAX_SUBJECT_LENGTH} chars)`,
      };
    }
  }

  return { valid: true, reason: null };
}

// --- Content quality checks ---

/**
 * Reject content that isn't a useful memory:
 * - Pure URLs with no context
 * - Single words (not a claim)
 * - All-caps screaming
 * - Repetitive characters
 */
export function validateContent(claim: string): ValidationResult {
  const trimmed = claim.trim();

  // Pure URL
  if (/^https?:\/\/\S+$/.test(trimmed) && !trimmed.includes(' ')) {
    return { valid: false, reason: 'Bare URL without context' };
  }

  // Single word
  if (!trimmed.includes(' ')) {
    return { valid: false, reason: 'Single word is not a claim' };
  }

  // All caps (more than 10 chars, >80% uppercase)
  // M1: Unicode-aware uppercase detection (catches non-Latin uppercase)
  if (trimmed.length > 10) {
    const chars = [...trimmed];
    const upper = chars.filter((c) => /\p{Lu}/u.test(c)).length;
    const alpha = chars.filter((c) => /\p{L}/u.test(c)).length;
    if (alpha > 0 && upper / alpha > 0.8) {
      return { valid: false, reason: 'All-caps content rejected' };
    }
  }

  // Repetitive (same char repeated 5+ times)
  if (/(.)\1{4,}/.test(trimmed)) {
    return {
      valid: false,
      reason: 'Repetitive character pattern detected',
    };
  }

  return { valid: true, reason: null };
}

// --- Injection detection ---

/**
 * Patterns that indicate prompt injection or system prompt content.
 * These should never be stored as memories.
 *
 * Categories:
 * 1. System prompt fragments (role assignments, instruction overrides)
 * 2. Architecture dumps (code, config, schema dumps)
 * 3. Control flow manipulation (ignore previous, act as)
 */

const INJECTION_PATTERNS: { pattern: RegExp; label: string }[] = [
  // System prompt fragments
  {
    pattern: /you\s+are\s+(a|an)\s+(helpful|AI|assistant|language\s+model)/i,
    label: 'system-role-assignment',
  },
  {
    pattern: /system\s*prompt|system\s*message|system\s*instruction/i,
    label: 'system-prompt-reference',
  },
  {
    pattern: /\bact\s+as\b.*\b(assistant|AI|model|chatbot)\b/i,
    label: 'role-override',
  },

  // Control flow manipulation
  {
    pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|rules?|context)/i,
    label: 'instruction-override',
  },
  {
    pattern: /disregard\s+(all\s+)?(previous|prior|above)/i,
    label: 'instruction-override',
  },
  {
    pattern: /forget\s+(everything|all|what)\s+(you|I)\s+(told|said|know)/i,
    label: 'memory-wipe-attempt',
  },
  {
    pattern: /new\s+instructions?:\s/i,
    label: 'instruction-injection',
  },

  // Architecture / config dumps
  {
    pattern: /```[\s\S]{200,}```/,
    label: 'code-block-dump',
  },
  {
    pattern: /\{[\s\S]{20,}"(api_key|apiKey|secret|token|password)"[\s\S]*\}/,
    label: 'credential-in-json',
  },
  {
    pattern: /CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE/i,
    label: 'sql-ddl',
  },

  // Encoding tricks
  {
    pattern: /&#x[0-9a-f]{2,};/i,
    label: 'html-entity-encoding',
  },
  {
    pattern: /\\u[0-9a-f]{4}/i,
    label: 'unicode-escape',
  },

  // F4: Base64 encoded instructions (JWT-like patterns)
  {
    pattern: /\b(eyJ[A-Za-z0-9+/=]{20,})\b/,
    label: 'base64-encoded-instruction',
  },

  // F4: XML/HTML control tags used for injection framing
  {
    pattern: /<\s*(policy|instruction|system|rules|prompt|config)\b[^>]*>/i,
    label: 'xml-control-tag',
  },
  {
    pattern: /<\s*\/\s*(policy|instruction|system|rules|prompt|config)\s*>/i,
    label: 'xml-control-close-tag',
  },

  // F4: Prompt extraction attempts
  {
    pattern: /translate\s+the\s+(following\s+)?(system\s+)?prompt/i,
    label: 'prompt-extraction-attempt',
  },

  // F4: Role-play and behavioral overrides
  {
    pattern: /you\s+are\s+now\s+\w+\s+with\s+new\s+rules/i,
    label: 'role-play-override',
  },
  {
    pattern: /from\s+now\s+on\s+(you|your)\s+(are|will|must|should)/i,
    label: 'behavioral-override',
  },
  {
    pattern: /override\s+(your|all|the|any)\s+(instructions?|rules?|guidelines?|constraints?)/i,
    label: 'direct-override-attempt',
  },
  {
    pattern: /pretend\s+(you|that|to)\s+(are|be|have)\s+(a|an|no|without)/i,
    label: 'pretend-jailbreak',
  },

  // F4: Known jailbreak prefixes
  {
    pattern: /\b(jailbreak|DAN|do\s+anything\s+now|developer\s+mode)\b/i,
    label: 'known-jailbreak-prefix',
  },
  {
    pattern: /respond\s+(only\s+)?with(out)?\s+(any\s+)?(restrictions?|limitations?|filters?|safety)/i,
    label: 'restriction-removal',
  },

  // F4: Chat template injection markers
  {
    pattern: /\[INST\]|\[\/INST\]|<\|im_start\|>|<\|im_end\|>/,
    label: 'chat-template-injection',
  },

  // F4: Unicode steganography (clusters of invisible chars)
  {
    pattern: /[\u200B-\u200F\u2028-\u202F\u2060-\u206F]{3,}/,
    label: 'unicode-steganography',
  },
];

/**
 * F4: Entropy-based gibberish detector.
 * High avg word length + few words = likely encoded/obfuscated content.
 */
export function detectGibberish(text: string): ValidationResult {
  if (text.length < 50) return { valid: true, reason: null };
  const words = text.split(/\s+/);
  const avgWordLen = text.replace(/\s/g, '').length / Math.max(words.length, 1);
  if (avgWordLen > 20 && words.length < 5) {
    return { valid: false, reason: 'Rejected: gibberish/encoded content (high avg word length)' };
  }
  const charFreq = new Map<string, number>();
  for (const ch of text) {
    charFreq.set(ch, (charFreq.get(ch) || 0) + 1);
  }
  const uniqueRatio = charFreq.size / text.length;
  if (uniqueRatio < 0.05 && text.length > 100) {
    return { valid: false, reason: 'Rejected: extremely low character diversity' };
  }
  return { valid: true, reason: null };
}

export function detectInjection(claim: string): ValidationResult {
  for (const { pattern, label } of INJECTION_PATTERNS) {
    if (pattern.test(claim)) {
      return { valid: false, reason: `Injection pattern: ${label}` };
    }
  }
  return { valid: true, reason: null };
}

// --- Feedback loop detection ---

/**
 * Detect if a new claim is just restating something the system
 * already knows. Exact match on normalized text.
 * Embedding-based dedup is in dedup.ts (separate concern).
 */
export function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Unicode tricks ---

const ZERO_WIDTH_CHARS = /\u200B|\u200C|\u200D|\u200E|\u200F|\uFEFF/;
const CYRILLIC_PATTERN = /[\u0400-\u04FF]/;
const LATIN_PATTERN = /[a-zA-Z]/;

export function detectSuspiciousUnicode(text: string): ValidationResult {
  if (ZERO_WIDTH_CHARS.test(text)) {
    return { valid: false, reason: 'Rejected: contains zero-width characters' };
  }
  if (CYRILLIC_PATTERN.test(text) && LATIN_PATTERN.test(text)) {
    return { valid: false, reason: 'Rejected: mixed Cyrillic and Latin script' };
  }
  return { valid: true, reason: null };
}

// --- Combined validator ---

/**
 * Run all validators in sequence. First failure wins.
 * Returns the failing result, or { valid: true } if all pass.
 */
export function validateMemoryInput(claim: string, subject?: string): ValidationResult {
  const unicodeResult = detectSuspiciousUnicode(claim);
  if (!unicodeResult.valid) return unicodeResult;

  // C3: Also validate subject for injection and unicode tricks.
  // Subject is used in FTS, embedding contextualization, and consensus prompts.
  if (subject) {
    const subjectUnicode = detectSuspiciousUnicode(subject);
    if (!subjectUnicode.valid) return { valid: false, reason: `Subject: ${subjectUnicode.reason}` };
    const subjectInjection = detectInjection(subject);
    if (!subjectInjection.valid) return { valid: false, reason: `Subject: ${subjectInjection.reason}` };
  }

  const formatResult = validateFormat(claim, subject);
  if (!formatResult.valid) return formatResult;

  const contentResult = validateContent(claim);
  if (!contentResult.valid) return contentResult;

  const injectionResult = detectInjection(claim);
  if (!injectionResult.valid) return injectionResult;

  const gibberishResult = detectGibberish(claim);
  if (!gibberishResult.valid) return gibberishResult;

  return { valid: true, reason: null };
}
