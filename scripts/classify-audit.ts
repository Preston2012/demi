import { classifyQuery } from "../src/retrieval/query-classifier.js";
import { readFileSync } from "fs";

const results = JSON.parse(readFileSync("benchmark-results/locomo-official-2026-04-13T03-44-23-252Z.json", "utf8"));
const catNames: Record<number, string> = {1: "single-hop", 2: "multi-hop", 3: "temporal", 4: "open-domain"};
const SIMPLE = new Set(["single-hop", "open-domain", "current-state"]);
const COMPLEX = new Set(["multi-hop", "temporal", "synthesis", "narrative", "coverage"]);

// Classify each question
const misroutes: any[] = [];
const routeStats = { simple: 0, complex: 0, total: 0 };
const classifiedAs: Record<string, number> = {};

for (const r of results.results) {
  const locomoCat = catNames[r.category] || "unknown";
  const ourClass = classifyQuery(r.question);
  const ourRoute = SIMPLE.has(ourClass) ? "simple" : "complex";
  routeStats[ourRoute]++;
  routeStats.total++;
  classifiedAs[ourClass] = (classifiedAs[ourClass] || 0) + 1;

  // Mis-route: LOCOMO says simple (cat 1 or 4) but we route to complex
  // Or: LOCOMO says complex (cat 2 or 3) but we route to simple
  const locomoSimple = r.category === 1 || r.category === 4;
  const locomoComplex = r.category === 2 || r.category === 3;

  if ((locomoSimple && ourRoute === "complex") || (locomoComplex && ourRoute === "simple")) {
    misroutes.push({
      id: `c${r.conversation_index}q${r.question_index}`,
      q: r.question.substring(0, 100),
      locomoCat,
      ourClass,
      ourRoute,
      correct: r.llm_judge_correct,
    });
  }
}

console.log("ROUTE STATS:", JSON.stringify(routeStats));
console.log("CLASSIFIED AS:", JSON.stringify(classifiedAs, null, 2));
console.log("\nMIS-ROUTES:", misroutes.length);
console.log("\nSimple questions routed to complex (costs money, may hurt):");
const simpleToComplex = misroutes.filter(m => (m.locomoCat === "single-hop" || m.locomoCat === "open-domain") && m.ourRoute === "complex");
console.log("Count:", simpleToComplex.length);
simpleToComplex.forEach(m => console.log(`  ${m.id} [${m.locomoCat}→${m.ourClass}] ${m.correct ? "✓" : "✗"} ${m.q}`));

console.log("\nComplex questions routed to simple (misses reasoning):");
const complexToSimple = misroutes.filter(m => (m.locomoCat === "multi-hop" || m.locomoCat === "temporal") && m.ourRoute === "simple");
console.log("Count:", complexToSimple.length);
complexToSimple.forEach(m => console.log(`  ${m.id} [${m.locomoCat}→${m.ourClass}] ${m.correct ? "✓" : "✗"} ${m.q}`));
