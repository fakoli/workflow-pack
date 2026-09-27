# workflow-pack working conventions

- The manifest (`pack/workflow-pack.v1.json`) is the single source of truth.
  `dist/` is generated — never hand-edit; run `node scripts/build.mjs`.
- Scripts are stdlib-only (Node stdlib, bash, python3 stdlib). No new runtime
  dependencies without explicit sign-off.
- Run `node lint/check.mjs` before every commit; run
  `node lint/check.mjs --installed` after touching install targets.
- Skill descriptions are the trigger surface: any new `verb_families` trigger
  phrase must be covered by some skill's description (the lint enforces this).
- Fixtures spawn real ephemeral agent sessions and cost tokens — run with
  intent, and never commit `fixtures/results/`.
- Every tracked file is public: no credentials, tokens, personal paths,
  tailnet names, or hostnames. Synthetic fixtures only (`127.0.0.1`, example
  names).
- URLs use `127.0.0.1`, never `localhost`.
