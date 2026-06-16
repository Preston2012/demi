/**
 * Bench 6 (Intent Inference Under Ambiguity), Zod schema for scenarios.
 *
 * Each scenario is a small closed world (3-5 entities, 6-10 facts) with
 * deliberately ambiguous questions. Each question has a "preferred"
 * interpretation (the contextually correct one) and an "incorrect"
 * interpretation (also plausible from the corpus, hence the ambiguity).
 */

import { z } from 'zod';

export const AmbiguityType = z.enum(['pronoun', 'partial-name', 'time-relative', 'polysemy', 'default-reference']);
export type AmbiguityType = z.infer<typeof AmbiguityType>;

export const FactSchema = z.object({
  fact_id: z.string().min(1),
  text: z.string().min(1),
  /** Entity this fact is "about", used for disambiguation rate. */
  about_entity: z.string().min(1),
});

export const QuestionSchema = z.object({
  question_id: z.string().min(1),
  ambiguity_type: AmbiguityType,
  question: z.string().min(1),
  preferred_interpretation: z.object({
    /** Entity the question is intended to be about. */
    entity: z.string().min(1),
    /** Ground truth answer assuming the preferred interpretation. */
    answer: z.string().min(1),
    /** fact_ids supporting the preferred answer. */
    evidence: z.array(z.string().min(1)).min(1),
  }),
  incorrect_interpretation: z.object({
    /** Entity the wrong interpretation would target. */
    entity: z.string().min(1),
    /** What the answer would be under the wrong interpretation. */
    answer: z.string().min(1),
  }),
});

export const ScenarioSchema = z.object({
  scenario_id: z.string().min(1),
  entities: z.array(z.string().min(1)).min(2).max(8),
  facts: z.array(FactSchema).min(4).max(15),
  questions: z.array(QuestionSchema).min(2).max(5),
});

export const FixtureSchema = z.object({
  version: z.string(),
  scenarios: z.array(ScenarioSchema),
});

export type Fact = z.infer<typeof FactSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;
export type Fixture = z.infer<typeof FixtureSchema>;
