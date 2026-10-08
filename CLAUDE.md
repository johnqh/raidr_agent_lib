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

## The agent flow (`src/business/runner/`, also `@sudobility/raidr_agent_lib/runner`)

Shared by raidr_agent_api (cloud runs) and the app (local runs). RN-safe: no
Node imports, no `URL` class. The `./runner` subpath imports only `zod`,
`@sudobility/raidr_types` and types, so the API can use it without react.

Steps (one ShapeShyft endpoint each, through `AiTransport.invoke(step, input)`;
`AgentStep` = `understand | rank-sites | prepare | plan | extract | pick-best`):

- `understandIntent(ai, { request, vocabulary?, country?, locale?, timeZone?, now? }): Promise<AgentIntent>`
  — six W's + `selection`, normalised by `toAgentIntent` (unknown W's → null,
  unknown selection → `all`, `location_needed = where.kind === 'current'`).
- `rankSites(ai, { request, intent, country?, candidates }): Promise<CandidateSite[]>`
  — model order, only input apiHosts, deduped, ≤12, `reason` set; an unusable
  answer keeps the candidates' order.
- `prepareSites(ai, catalog: SiteContextSource | SiteCatalog, { request, intent, location?, sites }): Promise<PrepareResponse>`
  — per site: tools checked against the manifest (≤6, else the 3 best-ranked),
  `login` forced `none` when `manifest.auth.style === 'none'`, `unsupported`
  sites reported and left out of the form; `mergeForm(fields[][])` dedupes by
  name (first wins, options union, required if any; ≤12).
- `runSites(input: RunRequest, writer, deps, options?): Promise<RunOutcome>`
  (`{ sites, results, best }`) and `runSite(...)`; `RunDeps = { ai; catalog: SiteContextSource | SiteCatalog; connector; newId? }`;
  `RunOptions = { maxSteps? (4), concurrency? (4), onCall?, signal? }`. The
  planner gets the W's, `inputs` (form answers) and `preferredTools` (the
  site's prepared `tools`, ranked first). Each successful call's JSON body
  (`ToolCallResult.body`, else `text` parsed after an optional `HTTP 200` line,
  ≤ `MAX_UPSTREAM_BYTES`) is kept for the run; the extractor sees short call
  ids (`c1`…) and returns `ref: { callId, itemPath }`, which becomes
  `ResultItem.source` and, through `buildPageUrl`, `pageUrl`. Results are in
  site order. `single`/`best` intents end with `pickBest` → `data-best`
  (one result is the best without asking; a bad answer → the first result).
  A failed site whose every call was 401/403 has `needsSignIn: true` (outcome
  and `data-site-status`).
- `buildPageUrl(routes, { endpoint, itemPath }, body, siteOrigins): string` —
  rules a–f of CONTRACTS_V2 (urlFields with the item's array prefix stripped
  first, then templates whose every param resolves from the item; routes by
  source strength then fewer query params; host must be a site origin or a
  subdomain, `www.` ignored; else `''`). Helpers: `resolvePath(body, path)`,
  `relativeField`, `isOnSite`, `orderRoutes`, `toolEndpoint(tool)`
  (`evidence.endpointKey ?? 'METHOD pathTemplate'`).
- Schemas (tolerant zod, `./schemas`): `understandOutputSchema`,
  `rankSitesSchema`, `prepareSchema` (+ `toFormField`, `canonicalFieldName`),
  `planSchema`, `extractSchema` (+ `extractItemSchema`), `pickBestSchema`, and
  the strict `agentIntentSchema` for intents sent back by clients.
- `STEP_SCHEMAS` (JSON Schemas of each endpoint's input/output) and
  `STEP_ENDPOINTS` (hosted names) in `./stepSchemas`; `stepSchemas.test.ts`
  checks they agree with the zod schemas. raidr_agent_api's
  `shapeshyft/endpoints/*.json` must carry them verbatim.
- Interfaces: `AiTransport`, `SiteContextSource.context(apiHost)`,
  `SiteCatalog.manifest(apiHost)` (still what `DirectSiteConnector` needs),
  `SiteConnector.open(apiHost, token?)` → `ToolSession`, `RunWriter.write(part)`
  (`RunPart` = the typed `data-*` parts incl. `data-best`).
- `rankTools(tools, text, preferred?)`, `safeUrl`, `describeError`,
  `parseCallBody`, `loadSiteContext`, `MAX_TOOLS`, `EXCERPT_BYTES`, `randomId`.
- `DirectSiteConnector({ catalog, fetch, allowLocalhost?, timeoutMs?, maxBytes? })`:
  calls a site from the device with raidr_types' `buildUpstreamRequest` +
  `assertSafeUpstream`; `redirect: 'manual'`, a 3xx or a response from another
  host is a failed call; body cut at `MAX_UPSTREAM_BYTES` characters; `ok` = 2xx.
  Never throws from `callTool`. `fetch` is a `FetchLike`.
- `createLocalRunRecorder({ request, intent, forward?, now? })` →
  `{ writer, toImportRequest(status = 'done'): RunImportRequest }`: unfinished
  sites become failed, running calls are dropped, lists are capped at
  `RUN_IMPORT_LIMITS`, `best` kept only when its result is uploaded.

`zod` (^4) is a peer dependency.

## Notes

- Placeholder exports: `useApiStatusStore` / `ApiStatusState` and `useApiStatus` / `UseApiStatusReturn`.
- Stores hold app-side state only; data fetching stays in raidr_agent_client hooks.
- Intended home for the agent flow: request -> intent (shapeshyft) -> label-filtered MCP servers -> per-site sign-in state -> results.
- Site session tokens obtained in the web view belong on the device; never add them to API calls to raidr_agent_api.

## CI/CD

`.github/workflows/ci-cd.yml` calls `johnqh/workflows/.github/workflows/unified-cicd.yml@main` on push and PR to `main` and `develop`.

## Origin

Scaffolded from the mogulgame repos (themselves a copy of the company "starter" template), with the game domain removed.
