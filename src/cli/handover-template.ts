/**
 * W4.6 handover template fill logic.
 *
 * Spec: docs/internal/WEDGE_4_6_CLIENT_SURFACE_DESIGN.md section 6.1.
 *
 * Pure functions only, so the substitution is unit-testable without running
 * the interactive CLI. docs/client/HANDOVER_TEMPLATE.md is the source template;
 * the CLI prompts the operator for the fields below and substitutes them.
 */

/** Template placeholder names the handover CLI fills in. */
export const HANDOVER_FIELDS = [
  'CLIENT_NAME',
  'CLIENT_EMAIL',
  'SERVICE_PROVIDER',
  'SERVICE_PROVIDER_EMAIL',
  'HOSTNAME',
  'HOST_IP',
  'DATACENTER',
  'INSTALL_DATE',
  'ENGINE_VERSION',
  'KEY_FINGERPRINTS',
  'OPS_ACCOUNT',
] as const;

export type HandoverField = (typeof HANDOVER_FIELDS)[number];
export type HandoverValues = Record<HandoverField, string>;

/** Substitute every `{{FIELD}}` placeholder with its value. */
export function fillTemplate(template: string, values: HandoverValues): string {
  return HANDOVER_FIELDS.reduce((doc, field) => doc.replaceAll(`{{${field}}}`, values[field]), template);
}

/** Return the list of `{{...}}` placeholders still present in a document. */
export function remainingPlaceholders(doc: string): string[] {
  const matches = doc.match(/\{\{[A-Z_]+\}\}/g);
  return matches ? [...new Set(matches)] : [];
}
