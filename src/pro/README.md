# src/pro/, Proprietary (Pro tier)

**This directory is the "furniture" in the "give the house, keep the furniture" model.**

Nothing in this directory is ever published to `github.com/Preston2012/demi` (the public Core repo).

Safeguards that enforce this:
1. `.gitattributes` has `export-ignore` on `src/pro/**`
2. The release clone at `/root/demi-release` has a pre-push hook that refuses any push containing `src/pro/` paths
3. The release script `/root/scalpel-ik/release-to-demi.sh` excludes `src/pro/` via rsync

If a file lives here, it is never public. Full stop.

## What lives here

- Pro tier features (consensus escalation beyond MVP, reflection engine, multi-model adjudication)
- Anything Preston decides is differentiated product value

## What does NOT live here

- Core retrieval, write pipeline, schema, trust branching, those are Core, under `src/` at the top level
- Experiments and prototypes, those go in `src/labs/`
