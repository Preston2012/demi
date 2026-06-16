import { callLLM } from '../llm/client.js';
/**
 * LongMemEval evaluator.
 *
 * Uses LLM-as-judge matching the official LongMemEval evaluation prompts
 * from xiaowu0162/LongMemEval/src/evaluation/evaluate_qa.py.
 *
 * Binary: yes/no per question. Same methodology as published scores.
 */

/**
 * Official LongMemEval evaluation prompt for standard question types.
 */
function buildEvalPrompt(questionType: string, question: string, referenceAnswer: string, hypothesis: string): string {
  // Abstention questions (marked with '_abs')
  if (questionType.endsWith('_abs') || questionType === 'abstention') {
    return `I will give you a question and a response from a model. The question is unanswerable given the context. Please answer yes if the model correctly identifies that it cannot answer or says it doesn't have enough information. Otherwise, answer no.\n\nQuestion: ${question}\n\nModel Response: ${hypothesis}\n\nDoes the model correctly abstain from answering? Answer yes or no only.`;
  }

  // Temporal reasoning: allow off-by-one errors
  if (questionType === 'temporal-reasoning') {
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. For temporal questions involving counts of days/weeks/months, allow off-by-one errors.\n\nQuestion: ${question}\n\nCorrect Answer: ${referenceAnswer}\n\nModel Response: ${hypothesis}\n\nIs the model response correct? Answer yes or no only.`;
  }

  // Knowledge update: permit previous info alongside updated answer
  if (questionType === 'knowledge-update') {
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. The correct answer reflects the most recent information. If the model provides both old and new information but includes the correct updated answer, answer yes.\n\nQuestion: ${question}\n\nCorrect Answer: ${referenceAnswer}\n\nModel Response: ${hypothesis}\n\nIs the model response correct? Answer yes or no only.`;
  }

  // Default: standard evaluation
  return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: ${question}\n\nCorrect Answer: ${referenceAnswer}\n\nModel Response: ${hypothesis}\n\nIs the model response correct? Answer yes or no only.`;
}

/**
 * Judge a single answer using the official LongMemEval methodology.
 */
export async function judgeAnswer(
  questionType: string,
  question: string,
  referenceAnswer: string,
  hypothesis: string,
  apiKey: string,
  model: string = 'gpt-4o-mini',
): Promise<boolean> {
  void apiKey; // S65: kept for back-compat with judge callers; engine callLLM reads keys from env
  const prompt = buildEvalPrompt(questionType, question, referenceAnswer, hypothesis);

  // S65 M13: route through engine callLLM. Default judge gpt-4o-mini.
  const text = (
    await callLLM(
      model,
      'You are a strict correctness judge. Reply with the single word "yes" or "no" as instructed in the prompt.',
      prompt,
      10,
      0,
      { cacheKey: 'demiurge:lme:judge:v1' },
    )
  )
    .toLowerCase()
    .trim();

  // S65 prompt-audit pass 2: bug fix, earlier code did text.trim() then
  // startsWith('yes') without lowercasing. Capitalized 'Yes' from the model
  // would silently judge as 'no'. Now lowercased before the substring check.
  return text.startsWith('yes');
}
