/**
 * Bench 3 (Multi-Hop Chain), Zod schema for scenarios.
 *
 * Used by the generator to validate LLM output and by the runner to load
 * the committed fixture. Keeping the schema in a separate file avoids
 * circular imports between generator/judge/runner.
 */

import { z } from 'zod';

export const FactSchema = z.object({
  fact_id: z.string().min(1),
  text: z.string().min(1),
  /** Entities referenced by this fact (1-2). */
  entities: z.array(z.string().min(1)).min(1).max(3),
});

export const QuestionSchema = z.object({
  question_id: z.string().min(1),
  type: z.enum(['2-hop', '3-hop']),
  question: z.string().min(1),
  /** Ground truth answer (short string the judge expects in the response). */
  answer: z.string().min(1),
  /** Ordered list of fact_ids that must be retrieved to answer. */
  evidence_chain: z.array(z.string().min(1)).min(2),
});

export const ScenarioSchema = z.object({
  scenario_id: z.string().min(1),
  /** Closed-world entity list. */
  entities: z.array(z.string().min(1)).min(3).max(10),
  facts: z.array(FactSchema).min(4).max(15),
  questions: z.array(QuestionSchema).min(2).max(4),
});

export const FixtureSchema = z.object({
  version: z.string(),
  scenarios: z.array(ScenarioSchema),
});

export type Fact = z.infer<typeof FactSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;
export type Fixture = z.infer<typeof FixtureSchema>;
