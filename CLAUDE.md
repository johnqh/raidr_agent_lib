> **Git policy — never auto-commit or auto-push.** Leave work in the working tree. Run git commit, git push, gh pr create or a release script only when the user explicitly asks in that turn.

# raidr_agent_lib

Business logic shared by the apps: Zustand stores and hooks that compose raidr_agent_client hooks. No direct network calls.

**Package**: `@sudobility/raidr_agent_lib` (public on npm)

## What raidr_agent is

raidr_agent is a native agent app. It takes a user's request in plain language and:

1. finds the intent via **shapeshyft** (a hosted structured-AI endpoint);
2. filters the **raidr** catalog of MCP servers by label to the sites that can serve that intent;
3. signs the user in to those sites in an in-app **web view** — the site session tokens stay on the device and are never sent to the raidr_agent backend;
4. calls the sites through **raidr's hosted MCP** endpoint (raidr_api);
5. renders the results with the **Vercel AI SDK**.

## Layering

```
raidr_agent_types -> raidr_agent_client -> raidr_agent_lib -> raidr_agent_app_rn
raidr_agent_types ------------------------------------------> raidr_agent_api
```

- `raidr_agent_types` — shared TypeScript types and response helpers (no runtime deps).
- `raidr_agent_client` — `RaidrAgentClient` HTTP class (injected `NetworkClient`) + TanStack Query hooks.
- `raidr_agent_lib` — business logic: Zustand stores and hooks composed from client hooks.
- `raidr_agent_api` — Hono + Postgres (Drizzle) backend; Firebase auth; talks to shapeshyft and raidr.
- `raidr_agent_app_rn` — the React Native app (separate repo).

All repos use **Bun only** — never npm, yarn or pnpm.

## Project structure

```
src/
├── index.ts
└── business/
    ├── stores/apiStatusStore.ts   # useApiStatusStore (placeholder)
    └── hooks/useApiStatus.ts      # useApiStatus (placeholder; wraps useHealth + store)
```

## Commands

```bash
bun install           # see "Local dependency workaround"
bun run typecheck
bun run lint
bun run test:unit     # vitest (jsdom)
bun run build         # tsc -p tsconfig.build.json -> dist/
bun run verify
```

### Local dependency workaround

The `@sudobility/raidr_agent_*` packages are not published yet, so `bun install`
fails on them. Install everything else, then build the dependency locally and
copy its `dist/` and `package.json` into
`node_modules/@sudobility/<name>/`. Build order: types -> client -> lib -> api.

## Notes

- Placeholder exports: `useApiStatusStore` / `ApiStatusState` and `useApiStatus` / `UseApiStatusReturn`.
- Stores hold app-side state only; data fetching stays in raidr_agent_client hooks.
- Intended home for the agent flow: request -> intent (shapeshyft) -> label-filtered MCP servers -> per-site sign-in state -> results.
- Site session tokens obtained in the web view belong on the device; never add them to API calls to raidr_agent_api.

## CI/CD

`.github/workflows/ci-cd.yml` calls `johnqh/workflows/.github/workflows/unified-cicd.yml@main` on push and PR to `main` and `develop`.

## Origin

Scaffolded from the mogulgame repos (themselves a copy of the company "starter" template), with the game domain removed.
