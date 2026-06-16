/**
 * S49 classifier validation: print classifyQuery output for a set of queries.
 */
async function main() {
  const { classifyQuery } = await import('../src/retrieval/query-classifier.js');
  const queries = [
    'What allergies does the user have?',
    'Where does the user work?',
    'Where does the user currently work?',
    "What is the user's job?",
    "What is the user's address?",
    "Who is the user's manager?",
    'What does the user prefer for breakfast?',
    'Where did the user work?',
    'Where will the user travel?',
    'What jobs has the user had?',
    "What was the user's last position?",
    'Tell me about the user',
    "List all the user's past jobs",
    'When did the user start at Acme?',
    'Has the user ever lived in Boston?',
    'What did the user say about quitting?',
  ];
  for (const q of queries) {
    console.log(`${classifyQuery(q).padEnd(20)} | ${q}`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
