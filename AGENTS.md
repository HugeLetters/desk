# Desk

An OpenCode plugin plus a per-machine service: agents ask the user questions, the user answers on a page. Start from
[README.md](README.md).

- `bun run test` runs everything; `bun run typecheck` type-checks: `tsc` (patched on install, so editors and `tsc` show
  the Effect language service's diagnostics), then the language service's own check, which catches what the patched
  `tsc` misses; warnings fail both. `bun run lint` runs Biome (`bun run format` fixes formatting and
  import order).
- Effect is imported a module at a time: `import * as Effect from "effect/Effect"`, never `import { Effect } from
  "effect"`.
- Anything that starts a real service sets `DESK_HOME` (a temp dir) and `DESK_PORT` (not 47400), so the user's own
  desk stays untouched.
