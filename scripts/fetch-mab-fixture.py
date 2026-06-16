#!/usr/bin/env python3
"""Fetch a MemoryAgentBench fixture from HuggingFace and write to JSON.

Usage:
  python3 scripts/fetch-mab-fixture.py --competency Conflict_Resolution --source factconsolidation_sh_6k

Writes to /tmp/mab-${source}.json which the TypeScript runner reads.
This avoids rebuilding the Python data loader inside Node.
"""
import argparse, json, sys, os

ALLOWED_COMPETENCIES = {'Accurate_Retrieval', 'Test_Time_Learning', 'Long_Range_Understanding', 'Conflict_Resolution'}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--competency', required=True, choices=sorted(ALLOWED_COMPETENCIES))
    ap.add_argument('--source', required=True, help='e.g. factconsolidation_sh_6k')
    ap.add_argument('--out', default=None, help='Output path (default: /tmp/mab-${source}.json)')
    args = ap.parse_args()

    try:
        from datasets import load_dataset
    except ImportError:
        print('ERROR: datasets package not installed. Run: pip install datasets --break-system-packages', file=sys.stderr)
        sys.exit(1)

    print(f'Loading {args.competency} / {args.source} from ai-hyz/MemoryAgentBench...')
    ds = load_dataset('ai-hyz/MemoryAgentBench', split=args.competency, revision='main')
    matches = [s for s in ds if s.get('metadata', {}).get('source', '') == args.source]
    if not matches:
        sources = sorted(set(s.get('metadata', {}).get('source', '') for s in ds))
        print(f'ERROR: no samples with source={args.source}. Available: {sources}', file=sys.stderr)
        sys.exit(2)
    if len(matches) > 1:
        print(f'WARNING: {len(matches)} samples match. Using first.', file=sys.stderr)

    sample = matches[0]
    out_path = args.out or f'/tmp/mab-{args.source}.json'
    payload = {
        'context': sample['context'],
        'questions': list(sample['questions']),
        'answers': [list(a) if isinstance(a, list) else [str(a)] for a in sample['answers']],
        'metadata': dict(sample['metadata']),
    }
    with open(out_path, 'w') as f:
        json.dump(payload, f)
    print(f'Wrote {out_path}: ctx_len={len(payload["context"])} questions={len(payload["questions"])}')

if __name__ == '__main__':
    main()
