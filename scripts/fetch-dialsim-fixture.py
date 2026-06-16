#!/usr/bin/env python3
"""
DialSim fixture builder for Demiurge.

Reads from THUIR/MemoryBench HF dataset (corpus + Q/A pairs) and produces
a JSON fixture compatible with the Demiurge DialSim runner.

For each question, the fixture stores:
- the question text + golden answer
- the asker character (e.g. "Ross")
- the asked_at date (when the question is being asked)
- a reference to which utterances should be available (date <= asked_at)

The runner consumes this fixture and seeds Demiurge with all utterances dated
on or before asked_at, then queries with the question text under a 6-second
time budget.

Usage:
  python3 fetch-dialsim-fixture.py --shows friends bigbang theoffice --mode mini --out /workspaces/shared/dialsim-mini.json
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime
from huggingface_hub import hf_hub_download
import datasets

HEADER_RE = re.compile(r'\[Date: ([A-Za-z]+ \d+, \d+), Session #(\d+)\]')
CHAR_RE = re.compile(r'You are (\w+),')
ASKED_RE = re.compile(r'asked in the context of ([^.]+?)\.')

def parse_corpus(text):
    """Returns list of {date_iso, session_num, utterances: [str]}"""
    matches = list(HEADER_RE.finditer(text))
    out = []
    for i, m in enumerate(matches):
        start = m.end()
        end = matches[i+1].start() if i+1 < len(matches) else len(text)
        body = text[start:end].strip()
        utts = [l for l in body.split('\n') if l.strip() and ': ' in l]
        date_str = m.group(1)
        try:
            iso = datetime.strptime(date_str, '%B %d, %Y').strftime('%Y-%m-%d')
        except ValueError:
            continue
        out.append({
            'date_iso': iso,
            'date_raw': date_str,
            'session_num': int(m.group(2)),
            'utterances': utts,
        })
    return out

def parse_q(prompt):
    last_q = prompt.rfind('[Question]')
    last_a = prompt.rfind('[Answer]')
    if last_q == -1 or last_a == -1 or last_a <= last_q:
        return None
    return prompt[last_q+len('[Question]'):last_a].strip()

def parse_asked_date(prompt):
    m = ASKED_RE.search(prompt)
    if not m:
        return None
    raw = m.group(1).strip()
    try:
        return datetime.strptime(raw, '%B %d, %Y').strftime('%Y-%m-%d')
    except ValueError:
        return None

def parse_character(prompt):
    m = CHAR_RE.search(prompt)
    return m.group(1) if m else None

def build_show_fixture(show, mode, cache_dir):
    print(f'[{show}] downloading corpus...', file=sys.stderr)
    corpus_fp = hf_hub_download(
        repo_id='THUIR/MemoryBench',
        filename=f'corpus/DialSim-{show}.jsonl',
        repo_type='dataset',
        cache_dir=cache_dir,
    )
    with open(corpus_fp) as f:
        corpus_text = json.loads(f.readline())['text']
    sessions = parse_corpus(corpus_text)
    total_utts = sum(len(s['utterances']) for s in sessions)
    print(f'[{show}] corpus: {len(sessions)} sessions, {total_utts} utterances', file=sys.stderr)

    print(f'[{show}] downloading Q/A...', file=sys.stderr)
    ds = datasets.load_dataset('THUIR/MemoryBench', f'DialSim-{show}', cache_dir=cache_dir)

    splits = ['test'] if mode == 'mini' else ['train', 'test']
    queries = []
    for split in splits:
        for row in ds[split]:
            prompt = row['input_prompt']
            info = row['info']
            if isinstance(info, str):
                info = json.loads(info)
            q_text = parse_q(prompt)
            asked_iso = parse_asked_date(prompt)
            character = parse_character(prompt)
            if not all([q_text, asked_iso, character]):
                print(f'[{show}] SKIP {split} idx={row["test_idx"]}: parse-fail', file=sys.stderr)
                continue
            queries.append({
                'qid': f'{show}_{split}_{row["test_idx"]}',
                'question': q_text,
                'expected': info.get('golden_answer', ''),
                'asker': character,
                'asked_at': asked_iso,
                'meta': {
                    'episode': info.get('episode'),
                    'session_num': info.get('session_num'),
                    'conversation_num': info.get('conversation_num'),
                    'split': split,
                },
            })

    print(f'[{show}] {len(queries)} queries built', file=sys.stderr)
    return {
        'show': show,
        'sessions': sessions,
        'queries': queries,
    }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--shows', nargs='+', default=['friends', 'bigbang', 'theoffice'])
    ap.add_argument('--mode', choices=['mini', 'full'], default='mini')
    ap.add_argument('--out', required=True)
    ap.add_argument('--cache-dir', default='/tmp/hf-cache')
    args = ap.parse_args()

    fixture = {
        'bench_id': 'dialsim',
        'upstream_version': 'THUIR/MemoryBench',
        'description': 'DialSim long-term multi-party dialogue (Friends/BigBang/TheOffice). Per-Q seeding with utterances dated <= asked_at. 6-sec time-bound.',
        'mode': args.mode,
        'shows': {},
    }

    for show in args.shows:
        fixture['shows'][show] = build_show_fixture(show, args.mode, args.cache_dir)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'w') as f:
        json.dump(fixture, f)

    total_q = sum(len(s['queries']) for s in fixture['shows'].values())
    total_s = sum(len(s['sessions']) for s in fixture['shows'].values())
    total_u = sum(sum(len(sess['utterances']) for sess in s['sessions']) for s in fixture['shows'].values())
    print(f'\n=== FIXTURE WRITTEN: {args.out} ===', file=sys.stderr)
    print(f'  Mode: {args.mode}', file=sys.stderr)
    print(f'  Shows: {list(fixture["shows"].keys())}', file=sys.stderr)
    print(f'  Total sessions: {total_s}', file=sys.stderr)
    print(f'  Total utterances: {total_u}', file=sys.stderr)
    print(f'  Total queries: {total_q}', file=sys.stderr)
    print(f'  Size: {os.path.getsize(args.out) / 1024 / 1024:.1f}MB', file=sys.stderr)

if __name__ == '__main__':
    main()
