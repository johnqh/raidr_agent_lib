# raidr_agent_lib

Business logic shared by the apps: Zustand stores and hooks that compose raidr_agent_client hooks. No direct network calls.

Part of **raidr_agent**: a native agent app that turns a user request into an intent (shapeshyft), picks matching raidr MCP servers by label, signs the user in to those sites in a web view (tokens stay on device), calls them through raidr's hosted MCP, and shows the results with the Vercel AI SDK.

Layering: `raidr_agent_types` -> `raidr_agent_client` -> `raidr_agent_lib` -> `raidr_agent_api` / `raidr_agent_app_rn`.

## Development

Bun only.

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

## License

BUSL-1.1
