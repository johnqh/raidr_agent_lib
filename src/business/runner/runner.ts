/**
 * One run: for each chosen site, the agent loop and then result extraction,
 * streamed as AI SDK–shaped data parts. Shared by raidr_agent_api (cloud runs:
 * ShapeShyft + raidr's hosted MCP) and the app (local runs: the user's own
 * LLM key + direct site calls).
 *
 * Per site (at most `concurrency` sites at once):
 *   1. load its context (manifest, tool auth, page routes) and rank its
 *      tools against the request, the tools `prepare` chose first;
 *   2. loop: the `plan` step picks up to 3 calls → each runs through the
 *      {@link SiteConnector}'s session → the result goes into `history` —
 *      until the planner says done or `maxSteps` rounds have run;
 *   3. the `extract` step turns the successful responses into result cards,
 *      each pointing at its item in a response (`ref`); the card's page URL
 *      is built from the site's routes and that item ({@link buildPageUrl}).
 * Then, for `single`/`best` requests, `pick-best` chooses one result
 * (`data-best`).
 *
 * The site token arrives with the run, is handed to the connector, and goes
 * nowhere else: not into parts, history, the model input or `onCall`.
 *
 * RN-safe: no Node imports, no `URL` class (React Native's is incomplete).
 */
import {
  MAX_UPSTREAM_BYTES,
  type McpManifest,
  type McpTool,
  parseHttpUrl,
} from '@sudobility/raidr_types';
import type {
  AgentStep,
  BestData,
  CallData,
  RaidrAgentDataParts,
  ResultItem,
  ResultSource,
  RunRequest,
  SiteContext,
  SiteRunStatus,
} from '@sudobility/raidr_agent_types';
import { extractSchema, planSchema } from './schemas';
import { randomId } from './ids';
import { buildPageUrl, toolEndpoint } from './pageUrl';
import { pickBest } from './steps';

/** Most tools shown to the planner per site. */
export const MAX_TOOLS = 40;
/** Most characters of one response kept for the planner and the extractor. */
export const EXCERPT_BYTES = 6_000;

/** Every model decision. Returns the model's (untrusted) structured output. */
export interface AiTransport {
  invoke(step: AgentStep, input: Record<string, unknown>): Promise<unknown>;
}

/** Where manifests come from (what {@link DirectSiteConnector} needs). */
export interface SiteCatalog {
  manifest(apiHost: string): Promise<McpManifest>;
}

/** Where site contexts come from: `GET /sites/:apiHost/context`, cached by the caller. */
export interface SiteContextSource {
  context(apiHost: string): Promise<SiteContext>;
}

/**
 * A site's context from either kind of catalog. A bare {@link SiteCatalog}
 * gives no tool auth and no routes (so no page URLs).
 */
export async function loadSiteContext(
  catalog: SiteContextSource | SiteCatalog,
  apiHost: string
): Promise<SiteContext> {
  if ('context' in catalog && typeof catalog.context === 'function')
    return catalog.context(apiHost);
  return {
    manifest: await (catalog as SiteCatalog).manifest(apiHost),
    toolAuth: {},
    routes: [],
  };
}

/** The outcome of one tool call. `text` is the response body (capped). */
export interface ToolCallResult {
  ok: boolean;
  /** Upstream HTTP status, when the site answered. */
  httpStatus?: number;
  text: string;
  /** The parsed JSON body, when the connector has it (else `text` is parsed). */
  body?: unknown;
}

/** An open connection to one site's tools. */
export interface ToolSession {
  callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolCallResult>;
  close(): Promise<void>;
}

/** Opens a {@link ToolSession} for a site, with the user's token when it needs one. */
export interface SiteConnector {
  open(apiHost: string, token?: string): Promise<ToolSession>;
}

/** One data part of a run's stream (`data-<key>` of {@link RaidrAgentDataParts}). */
export type RunPart = {
  [K in keyof RaidrAgentDataParts]: {
    type: `data-${K}`;
    id?: string;
    data: RaidrAgentDataParts[K];
  };
}[keyof RaidrAgentDataParts];

/**
 * Receives the run's parts. An AI SDK `UIMessageStreamWriter` fits; so does
 * a plain callback object on the device.
 */
export interface RunWriter {
  write(part: RunPart): void;
}

export interface RunDeps {
  ai: AiTransport;
  /** Site contexts (a bare {@link SiteCatalog} works too, without page URLs). */
  catalog: SiteContextSource | SiteCatalog;
  connector: SiteConnector;
  /** Call id generator; defaults to a portable UUID v4. */
  newId?: () => string;
}

export interface RunOptions {
  /** Plan rounds per site (default 4). */
  maxSteps?: number;
  /** Sites run at once (default 4). */
  concurrency?: number;
  /** Called after every finished tool call, for persistence (no token, no body). */
  onCall?: (call: CallData) => void | Promise<void>;
  /** Stops planning new rounds once aborted; calls in flight finish. */
  signal?: { readonly aborted: boolean };
}

export interface SiteOutcome {
  apiHost: string;
  status: SiteRunStatus;
  error: string | null;
  /** Every call was refused with 401/403: signing in may help. */
  needsSignIn?: boolean;
}

export interface RunOutcome {
  sites: SiteOutcome[];
  results: ResultItem[];
  /** The chosen result of a `single`/`best` run, also sent as `data-best`. */
  best: BestData | null;
}

/** Words of a text, for ranking tools against the request. */
function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(w => w.length > 2)
  );
}

/**
 * The tools worth showing the planner: `preferred` ones first (in their
 * order), then reads, then by overlap of the tool's name and description
 * with the request, capped at `MAX_TOOLS`.
 */
export function rankTools(
  tools: McpTool[],
  text: string,
  preferred: string[] = []
): McpTool[] {
  const wanted = words(text);
  const score = (t: McpTool) => {
    let s = t.request.method === 'GET' ? 2 : 0;
    for (const w of words(`${t.name} ${t.description}`))
      if (wanted.has(w)) s += 3;
    return s;
  };
  const rank = (t: McpTool) => {
    const i = preferred.indexOf(t.name);
    return i < 0 ? preferred.length : i;
  };
  return tools
    .map((t, i) => ({ t, i, s: score(t), p: rank(t) }))
    .sort((a, b) => a.p - b.p || b.s - a.s || a.i - b.i)
    .slice(0, MAX_TOOLS)
    .map(x => x.t);
}

/**
 * A tool call's body as JSON: the connector's parsed `body`, else `text`
 * parsed (a leading `HTTP 200` line, as raidr's hosted MCP writes it, is
 * skipped). Undefined when it is not JSON or is over `MAX_UPSTREAM_BYTES`.
 */
export function parseCallBody(result: ToolCallResult): unknown {
  if (result.body !== undefined) return result.body;
  const text = result.text.replace(/^HTTP \d{3}\r?\n/, '');
  if (!text || text.length > MAX_UPSTREAM_BYTES) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Only an absolute http(s) URL without credentials survives; anything else
 * (`javascript:`, relative, control characters) becomes empty. Spaces are
 * percent-encoded.
 */
export function safeUrl(url: string): string {
  const trimmed = url.trim();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f<>"\\]/.test(trimmed)) return '';
  const parsed = parseHttpUrl(trimmed);
  if (!parsed || parsed.hasCredentials) return '';
  return trimmed.replace(/ /g, '%20');
}

/** A message safe to show and store: no token can be in it, but cap it anyway. */
export function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 300);
}

/** One successful response, kept for extraction and page URLs. */
interface KeptResponse {
  callId: string;
  /** Short id the extractor sees (`c1`), mapped back to `callId`. */
  ref: string;
  tool: string;
  endpoint: string;
  excerpt: string;
  /** Parsed JSON body (≤ `MAX_UPSTREAM_BYTES`), when it is JSON. */
  body: unknown;
}

/** The six W's the planner sees, without the classifier's bookkeeping. */
function intentDetails(intent: RunRequest['intent']) {
  return {
    what: intent.what ?? intent.intent,
    who: intent.who ?? null,
    how: intent.how ?? null,
    when: intent.when ?? null,
    where: intent.where ?? null,
  };
}

/** Run one site: plan → call → extract. Never throws; a failure fails the site. */
export async function runSite(
  site: RunRequest['sites'][number],
  input: RunRequest,
  writer: RunWriter,
  deps: RunDeps,
  options: RunOptions = {}
): Promise<{ outcome: SiteOutcome; results: ResultItem[] }> {
  const { apiHost } = site;
  const newId = deps.newId ?? randomId;
  let title = apiHost;
  const status = (
    state: SiteRunStatus,
    extra: {
      message?: string;
      resultCount?: number;
      needsSignIn?: boolean;
    } = {}
  ) =>
    writer.write({
      type: 'data-site-status',
      id: `site:${apiHost}`,
      data: { apiHost, title, status: state, ...extra },
    });

  let session: ToolSession | null = null;
  try {
    status('planning');
    const context = await loadSiteContext(deps.catalog, apiHost);
    const { manifest } = context;
    title = manifest.title;
    status('planning');
    const toolByName = new Map(manifest.tools.map(t => [t.name, t]));
    const preferred = (site.tools ?? []).filter(name => toolByName.has(name));
    const tools = rankTools(
      manifest.tools,
      `${input.request} ${input.intent.query}`,
      preferred
    );
    session = await deps.connector.open(apiHost, site.token);
    const withLocation =
      input.intent.location_needed && input.location
        ? { location: input.location }
        : {};

    const history: Array<{
      tool: string;
      arguments: unknown;
      status: string;
      excerpt: string;
    }> = [];
    const responses: KeptResponse[] = [];
    /** HTTP statuses of the calls that reached the site. */
    const statuses: Array<number | undefined> = [];
    for (let step = 0; step < (options.maxSteps ?? 4); step++) {
      if (options.signal?.aborted) break;
      const planned = planSchema.safeParse(
        await deps.ai.invoke('plan', {
          request: input.request,
          intent: input.intent.intent,
          query: input.intent.query,
          ...intentDetails(input.intent),
          ...withLocation,
          ...(input.inputs && Object.keys(input.inputs).length > 0
            ? { inputs: input.inputs }
            : {}),
          ...(preferred.length > 0 ? { preferredTools: preferred } : {}),
          site: { title, apiHost, description: manifest.description },
          tools: tools.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
          // A snapshot: the array keeps growing after this call.
          history: [...history],
        })
      );
      if (
        !planned.success ||
        planned.data.done ||
        planned.data.calls.length === 0
      )
        break;
      status('calling');
      for (const call of planned.data.calls) {
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(call.arguments) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            args = parsed as Record<string, unknown>;
        } catch {
          history.push({
            tool: call.tool,
            arguments: call.arguments,
            status: 'error',
            excerpt: 'arguments were not valid JSON',
          });
          continue;
        }
        const tool = toolByName.get(call.tool);
        if (!tool) {
          history.push({
            tool: call.tool,
            arguments: args,
            status: 'error',
            excerpt: 'no such tool',
          });
          continue;
        }
        const callId = newId();
        const running: CallData = {
          callId,
          apiHost,
          tool: call.tool,
          arguments: args,
          status: 'running',
        };
        writer.write({
          type: 'data-call',
          id: `call:${callId}`,
          data: running,
        });
        const started = Date.now();
        let done: CallData;
        try {
          const result = await session.callTool(call.tool, args);
          const ok =
            result.ok &&
            (result.httpStatus === undefined || result.httpStatus < 400);
          done = {
            ...running,
            status: ok ? 'ok' : 'error',
            ...(result.httpStatus !== undefined
              ? { httpStatus: result.httpStatus }
              : {}),
            durationMs: Date.now() - started,
          };
          statuses.push(result.httpStatus);
          const body = ok ? parseCallBody(result) : undefined;
          // Compact JSON shows the model more of the body than pretty text.
          const excerpt = (
            body !== undefined ? JSON.stringify(body) : result.text
          ).slice(0, EXCERPT_BYTES);
          history.push({
            tool: call.tool,
            arguments: args,
            status: String(result.httpStatus ?? (ok ? 'ok' : 'error')),
            excerpt,
          });
          if (ok)
            responses.push({
              callId,
              ref: `c${responses.length + 1}`,
              tool: call.tool,
              endpoint: toolEndpoint(tool),
              excerpt,
              body,
            });
        } catch (error) {
          statuses.push(undefined);
          done = {
            ...running,
            status: 'error',
            durationMs: Date.now() - started,
          };
          history.push({
            tool: call.tool,
            arguments: args,
            status: 'error',
            excerpt: describeError(error),
          });
        }
        writer.write({ type: 'data-call', id: `call:${callId}`, data: done });
        await options.onCall?.(done);
      }
    }

    if (responses.length === 0) {
      const failedAll = history.length > 0;
      const needsSignIn =
        statuses.length > 0 && statuses.every(s => s === 401 || s === 403);
      const message = needsSignIn
        ? 'The site asked to sign in'
        : failedAll
          ? "The site's API did not answer"
          : 'Nothing on this site matched';
      status(failedAll ? 'failed' : 'done', {
        message,
        resultCount: 0,
        ...(needsSignIn ? { needsSignIn } : {}),
      });
      return {
        outcome: {
          apiHost,
          status: failedAll ? 'failed' : 'done',
          error: failedAll ? message : null,
          ...(needsSignIn ? { needsSignIn } : {}),
        },
        results: [],
      };
    }

    status('extracting');
    const shown = responses.slice(-6);
    const extracted = extractSchema.safeParse(
      await deps.ai.invoke('extract', {
        request: input.request,
        resultKind: input.intent.resultKind,
        ...withLocation,
        site: { title, apiHost },
        responses: shown.map(r => ({
          callId: r.ref,
          tool: r.tool,
          endpoint: r.endpoint,
          excerpt: r.excerpt,
        })),
      })
    );
    const byRef = new Map<string, KeptResponse>();
    for (const r of shown) {
      byRef.set(r.ref, r);
      // A model that echoes the full call id is understood too.
      byRef.set(r.callId, r);
    }
    const items: ResultItem[] = (
      extracted.success ? extracted.data.items : []
    ).map(({ ref, ...item }, i) => {
      const from = ref ? byRef.get(ref.callId) : undefined;
      const source: ResultSource | undefined =
        from && ref
          ? {
              callId: from.callId,
              tool: from.tool,
              endpoint: from.endpoint,
              itemPath: ref.itemPath,
            }
          : undefined;
      const pageUrl =
        source && from && from.body !== undefined
          ? buildPageUrl(
              context.routes,
              source,
              from.body,
              manifest.siteOrigins
            )
          : '';
      return {
        ...item,
        id: `${apiHost}:${i}`,
        apiHost,
        siteTitle: title,
        imageUrl: safeUrl(item.imageUrl),
        sourceUrl: safeUrl(item.sourceUrl),
        pageUrl: pageUrl ? safeUrl(pageUrl) : '',
        ...(source ? { source } : {}),
      };
    });
    for (const item of items)
      writer.write({
        type: 'data-result',
        id: `result:${item.id}`,
        data: item,
      });
    status('done', { resultCount: items.length });
    return {
      outcome: { apiHost, status: 'done', error: null },
      results: items,
    };
  } catch (error) {
    const message = describeError(error);
    status('failed', { message });
    return {
      outcome: { apiHost, status: 'failed', error: message },
      results: [],
    };
  } finally {
    await session?.close().catch(() => undefined);
  }
}

/**
 * Run every chosen site, `concurrency` at a time, then (for `single`/`best`
 * requests with results) pick the best one. Never throws for a site failure.
 * Results are in the order of `input.sites`, then extraction order.
 */
export async function runSites(
  input: RunRequest,
  writer: RunWriter,
  deps: RunDeps,
  options: RunOptions = {}
): Promise<RunOutcome> {
  for (const site of input.sites) {
    writer.write({
      type: 'data-site-status',
      id: `site:${site.apiHost}`,
      data: { apiHost: site.apiHost, title: site.apiHost, status: 'queued' },
    });
  }
  const queue = input.sites.map((site, index) => ({ site, index }));
  const done: Array<{ outcome: SiteOutcome; results: ResultItem[] }> = [];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      done[next.index] = await runSite(next.site, input, writer, deps, options);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(options.concurrency ?? 4, input.sites.length) },
      worker
    )
  );
  const sites = done.filter(Boolean).map(d => d.outcome);
  const results = done.filter(Boolean).flatMap(d => d.results);

  let best: BestData | null = null;
  const selection = input.intent.selection ?? 'all';
  if (selection !== 'all' && results.length > 0 && !options.signal?.aborted) {
    best = await pickBest(deps.ai, {
      request: input.request,
      intent: input.intent,
      results,
    });
    if (best) writer.write({ type: 'data-best', id: 'best', data: best });
  }
  return { sites, results, best };
}
