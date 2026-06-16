import type { FreeFormSecretDetector, DetectedSecret } from './types.js';

/**
 * Stage 2 (W6+) LLM-based free-form secret detection.
 *
 * v1 ships a NULL impl: the interface exists so call sites can be wired
 * today, and a real detector can be slotted in without code-site changes.
 */
export const NULL_FREEFORM_DETECTOR: FreeFormSecretDetector = {
  detectorName: 'null',
  async detect(_text: string): Promise<DetectedSecret[]> {
    return [];
  },
};
