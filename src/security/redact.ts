/**
 * Wedge 1.5 Phase 1: secret redaction infrastructure.
 *
 * Pure function `redactValue` masks values that look like secrets, based on
 * a) the variable name / key hint that holds the value (header name, env
 *    var, JSON property), and
 * b) the value's content matching known-secret prefixes (sk-, xai-, etc.).
 *
 * The pino logger uses `redact.paths` to mask at well-known JSON paths
 * BEFORE serialization (configured in src/config.ts createLogger).
 * `redactValue` is the secondary line for paths the logger can't statically
 * predict (dynamic JSON, error messages, audit logs).
 *
 * Design rules:
 *   - False positives are preferred over false negatives. If unsure, redact.
 *   - Redaction is one-way. We never store original alongside redacted.
 *   - Test fixtures use specific patterns (TEST_KEY_, NOT_SECRET_, ...) that
 *     never match the redaction rules.
 */

/** Token used to replace redacted values in logs. */
export const REDACTION_TOKEN = '[REDACTED]';

/** Key-name patterns that indicate the value is a secret. Case-insensitive. */
const SECRET_KEY_PATTERNS: RegExp[] = [
  /api[_-]?key/i,
  /auth[_-]?token/i,
  /access[_-]?token/i,
  /refresh[_-]?token/i,
  /bearer/i,
  /\bsecret\b/i,
  /\bpassword\b/i,
  /\bpasswd\b/i,
  /private[_-]?key/i,
  /encryption[_-]?key/i,
  /signing[_-]?key/i,
  /webhook[_-]?secret/i,
  /client[_-]?secret/i,
  /\btoken\b/i,
  /authorization/i,
  /db[_-]?key/i,
];

/** Value-prefix patterns that indicate a secret (known provider prefixes). */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  // OpenAI
  /^sk-[A-Za-z0-9_-]{16,}/,
  // Anthropic
  /^sk-ant-[A-Za-z0-9_-]{16,}/,
  // xAI
  /^xai-[A-Za-z0-9_-]{16,}/,
  // Google AI
  /^AIza[A-Za-z0-9_-]{16,}/,
  // GitHub PAT
  /^ghp_[A-Za-z0-9]{16,}/,
  /^github_pat_[A-Za-z0-9_]{16,}/,
  // Generic bearer token shape
  /^Bearer\s+[A-Za-z0-9._-]{16,}/i,
  // Long hex strings that look like keys (>= 32 hex chars)
  /^[a-f0-9]{32,}$/i,
  // JWT-shaped (three base64url segments separated by dots)
  /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
];

/**
 * Check whether a key hint (variable name, env name, JSON property)
 * suggests the value is a secret.
 */
export function isSecretKey(key: string): boolean {
  for (const re of SECRET_KEY_PATTERNS) {
    if (re.test(key)) return true;
  }
  return false;
}

/**
 * Check whether a value looks like a secret based on its content
 * (known provider prefixes, JWT shape, long hex).
 */
export function isSecretValue(value: string): boolean {
  if (typeof value !== 'string') return false;
  // Short values are unlikely to be secrets even if key name matches.
  if (value.length < 8) return false;
  for (const re of SECRET_VALUE_PATTERNS) {
    if (re.test(value)) return true;
  }
  return false;
}

/**
 * Redact a single value. Returns REDACTION_TOKEN if the value should be
 * masked, otherwise returns the value unchanged.
 *
 * @param value - the value to inspect
 * @param keyHint - optional context (variable name, env name, JSON property)
 */
export function redactValue(value: unknown, keyHint?: string): unknown {
  if (value === null || value === undefined) return value;

  // Non-string values are passed through unless the key is suspicious AND
  // the value is some kind of stringifiable object whose serialization
  // might contain a secret. For now, only inspect strings.
  if (typeof value !== 'string') return value;

  // If we have a key hint and it looks like a secret-holder, redact regardless
  // of the value's content (defense against weird short tokens).
  if (keyHint && isSecretKey(keyHint)) {
    return REDACTION_TOKEN;
  }

  // No key hint: only redact if the value's content matches a known shape.
  if (isSecretValue(value)) {
    return REDACTION_TOKEN;
  }

  return value;
}

/**
 * Recursively redact a JSON-like object. Walks all keys, applies redactValue
 * to each leaf with the key as hint. Arrays are walked element-wise without
 * a key hint (arrays of secrets are unusual; we still redact based on
 * value content).
 *
 * Depth-limited to prevent unbounded recursion on circular structures.
 */
export function redactObject(input: unknown, depth = 0): unknown {
  if (depth > 10) return '[REDACTED:TOO_DEEP]';
  if (input === null || input === undefined) return input;
  if (typeof input !== 'object') return input;
  if (Array.isArray(input)) {
    return input.map((v) => redactObject(v, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (isSecretKey(k)) {
      result[k] = REDACTION_TOKEN;
    } else if (typeof v === 'object' && v !== null) {
      result[k] = redactObject(v, depth + 1);
    } else if (typeof v === 'string') {
      result[k] = redactValue(v, k);
    } else {
      result[k] = v;
    }
  }
  return result;
}
