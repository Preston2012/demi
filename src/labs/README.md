# src/labs/, Experimental (prototype branch scratchpad)

**This directory holds rapid-prototype code.** Work here may break benchmarks, may be incomplete, may be abandoned.

Nothing in this directory is ever published to `github.com/Preston2012/demi`.

Safeguards match `src/pro/`: `.gitattributes` export-ignore, release clone pre-push hook refuses `src/labs/` paths, release script excludes it.

## Branch discipline

- `main` = golden stable. `src/labs/` code here should be dormant/reference only.
- `lab` branch (when created) = active experimentation. Code under `src/labs/` may be being actively written.

Graduation: when a `src/labs/` module earns its keep via benchmarks, move it to its proper home in `src/` (or `src/pro/` if it is a Pro feature) and delete the lab copy.
