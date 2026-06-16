/**
 * W4.5 v1 secret detection patterns.
 *
 * Spec: docs/internal/WEDGE_4_5_VAULT_DESIGN.md §7.
 *
 * 9 regex patterns covering the highest-signal credential surfaces:
 *   1. US SSN
 *   2. Credit card (Luhn-validated downstream by the detector)
 *   3. OpenAI API key
 *   4. Anthropic API key
 *   5. AWS access key id
 *   6. AWS secret access key
 *   7. GitHub personal access token
 *   8. PEM / SSH private key block
 *   9. Labelled high-entropy value (api_key=..., password=..., token=...)
 *
 * Patterns are intentionally conservative on entropy thresholds. The
 * detector exists to catch obvious credential leakage, not to be a full
 * DLP system. Free-form LLM detection lands in W6+ as Stage 2.
 */

export interface SecretPattern {
  /** Stable identifier used in audit logs and FP-rate telemetry. */
  name: string;
  /** Compiled regex; the global flag lets the detector iterate spans. */
  pattern: RegExp;
  /**
   * Optional post-match validator (e.g. Luhn for credit cards) that returns
   * `true` if the candidate should be reported as a secret.
   */
  validate?: (match: string) => boolean;
}

function luhnValid(input: string): boolean {
  const digits = input.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  {
    name: 'us-ssn',
    pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
  },
  {
    name: 'credit-card',
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    validate: luhnValid,
  },
  {
    // Negative lookahead `(?!ant-)` keeps Anthropic keys (which also begin
    // `sk-`) from being claimed by this rule. Tested in
    // tests/unit/secret-vault-detector.test.ts.
    name: 'openai-api-key',
    pattern: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    name: 'anthropic-api-key',
    pattern: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    name: 'aws-access-key-id',
    pattern: /\b(?:AKIA|ASIA|AIDA|AROA|AGPA|ANPA|ANVA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  },
  {
    name: 'aws-secret-access-key',
    pattern: /\b(?:aws_secret_access_key|aws-secret-access-key)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi,
  },
  {
    name: 'github-pat',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  },
  {
    name: 'pem-private-key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
  },
  {
    name: 'labelled-high-entropy',
    pattern: /\b(?:api[_-]?key|secret|password|passwd|token|bearer)\s*[:=]\s*['"]?([A-Za-z0-9_+/=.-]{16,})['"]?/gi,
  },
];
