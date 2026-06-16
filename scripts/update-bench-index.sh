#!/bin/bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"

OUT=benchmark-results/index.json
HOST=$(cat /etc/host-identity 2>/dev/null || echo UNKNOWN)
export OUT HOST

python3 - <<"PYEOF"
import json, os, glob, datetime, sys

OUT = os.environ['OUT']
HOST = os.environ['HOST']

entries = []
for f in sorted(glob.glob('benchmark-results/*.json')):
    if 'index.json' in f:
        continue
    try:
        d = json.load(open(f))
    except Exception:
        continue
    if not isinstance(d, dict):
        continue
    s = d.get('summary') or {}
    c = d.get('config') or {}
    bench = d.get('benchmark') or os.path.basename(f).split('-')[0]

    score = s.get('overallJScore') or s.get('overall') or s.get('accuracy')
    if score is None and s.get('jScoreCorrect') is not None and s.get('scoredQuestions'):
        score = s['jScoreCorrect'] / s['scoredQuestions']

    entries.append({
        'file': os.path.basename(f),
        'bench': bench,
        'timestamp': d.get('timestamp', ''),
        'totalQuestions': s.get('totalQuestions'),
        'scoredQuestions': s.get('scoredQuestions'),
        'score_pct': round(score * 100, 2) if isinstance(score, (int, float)) else None,
        'meanF1': s.get('meanF1'),
        'meanRetrievalMs': s.get('meanRetrievalMs'),
        'meanTotalMs': s.get('meanTotalMs'),
        'answerModel': c.get('answerModel'),
        'judgeModel': c.get('judgeModel'),
        'maxRules': c.get('maxRules'),
    })

entries.sort(key=lambda e: e['timestamp'], reverse=True)

out = {
    'generated_at': datetime.datetime.now(datetime.UTC).isoformat(),
    'host': HOST,
    'count': len(entries),
    'entries': entries,
}
open(OUT, 'w').write(json.dumps(out, indent=2))
print(f'Index written: {len(entries)} entries -> {OUT}')
PYEOF
