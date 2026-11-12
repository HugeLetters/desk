# Desk

An OpenCode plugin plus a per-machine service: agents ask the user questions, the user answers on a page. Start from
[README.md](README.md).

- `bun run test` runs everything; `bunx tsc --noEmit` type-checks, with the Effect language service's diagnostics
  (`tsc` is patched on install; warnings fail it); `bun run lint` runs Biome (`bun run format` fixes formatting and
  import order).
- Effect is imported a module at a time: `import * as Effect from "effect/Effect"`, never `import { Effect } from
  "effect"`.
- Anything that starts a real service sets `DESK_HOME` (a temp dir) and `DESK_PORT` (not 47400), so the user's own
  desk stays untouched.
