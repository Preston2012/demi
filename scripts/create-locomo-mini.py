#!/usr/bin/env python3
"""
LOCOMO-mini: Create a stratified random sample for fast A/B testing.

Picks ~300 questions from the full 1,986-question dataset,
preserving category distribution across all 10 conversations.
Outputs a JSON fixture of question indices to use.

Usage:
  python3 scripts/create-locomo-mini.py
  # Produces fixtures/benchmark/locomo-official/locomo-mini-indices.json
"""

import json
import random
import os

random.seed(42)  # Reproducible sample

DATASET_PATH = "./fixtures/benchmark/locomo-official/locomo10.json"
OUTPUT_PATH = "./fixtures/benchmark/locomo-official/locomo-mini-indices.json"

# Category mapping: JSON cat 1=multi-hop, 2=temporal, 3=open-domain, 4=single-hop, 5=adversarial
CAT_NAMES = {1: "multi-hop", 2: "temporal", 3: "open-domain", 4: "single-hop", 5: "adversarial"}

# Target: ~20% of scored questions per category per conversation
SAMPLE_RATE = 0.20

dataset = json.load(open(DATASET_PATH))
print(f"Loaded {len(dataset)} conversations")

mini_indices = []
total_sampled = 0
total_scored = 0
cat_counts = {}

for ci, conv in enumerate(dataset):
    qa_list = conv["qa"]
    
    # Group by category (excluding cat 5)
    by_cat = {}
    for qi, qa in enumerate(qa_list):
        cat = qa.get("category", 0)
        if cat == 5:
            continue
        if cat not in by_cat:
            by_cat[cat] = []
        by_cat[cat].append(qi)
    
    conv_sampled = []
    for cat, indices in by_cat.items():
        cat_name = CAT_NAMES.get(cat, f"cat{cat}")
        n_sample = max(2, int(len(indices) * SAMPLE_RATE))  # At least 2 per category
        sampled = sorted(random.sample(indices, min(n_sample, len(indices))))
        conv_sampled.extend(sampled)
        
        if cat_name not in cat_counts:
            cat_counts[cat_name] = {"total": 0, "sampled": 0}
        cat_counts[cat_name]["total"] += len(indices)
        cat_counts[cat_name]["sampled"] += len(sampled)
    
    conv_sampled.sort()
    mini_indices.append({
        "conversation_index": ci,
        "question_indices": conv_sampled,
        "total_in_conv": len(qa_list),
        "sampled": len(conv_sampled),
    })
    
    total_sampled += len(conv_sampled)
    total_scored += sum(len(v) for v in by_cat.values())
    print(f"  Conv {ci}: {len(conv_sampled)}/{len(qa_list)} sampled ({len(qa_list) - len([q for q in qa_list if q.get('category') == 5])} scored)")

print(f"\nTotal: {total_sampled}/{total_scored} scored questions ({total_sampled/total_scored*100:.1f}%)")
print("\nCategory distribution:")
for cat_name, counts in sorted(cat_counts.items()):
    pct_full = counts["total"] / total_scored * 100
    pct_mini = counts["sampled"] / total_sampled * 100
    print(f"  {cat_name}: {counts['sampled']}/{counts['total']} ({pct_mini:.1f}% mini vs {pct_full:.1f}% full)")

output = {
    "description": "LOCOMO-mini: stratified 20% sample for fast A/B testing",
    "seed": 42,
    "sample_rate": SAMPLE_RATE,
    "total_sampled": total_sampled,
    "total_scored": total_scored,
    "conversations": mini_indices,
}

os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
json.dump(output, open(OUTPUT_PATH, "w"), indent=2)
print(f"\nSaved to {OUTPUT_PATH}")
print(f"Expected run time: ~{total_sampled * 3 // 60} minutes (at ~3s/question)")
