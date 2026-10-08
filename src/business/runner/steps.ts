/**
 * The model decisions around a run: understand the request, rank the
 * candidate sites, prepare each chosen site (tools, sign-in, form), and pick
 * the best result. Each one calls one ShapeShyft endpoint through the
 * {@link AiTransport} and checks the (untrusted) answer.
 *
 * Shared by raidr_agent_api (cloud) and the app (local mode). RN-safe.
 */
import type {
  AgentIntent,
  BestData,
  CandidateSite,
  FormField,
  GeoLocation,
  PrepareResponse,
  ResultItem,
  SitePlan,
  ToolAuth,
} from '@sudobility/raidr_agent_types';
import type { AiTransport, SiteCatalog, SiteContextSource } from './runner';
import { loadSiteContext, rankTools } from './runner';
import {
  MAX_PREPARED_TOOLS,
  pickBestSchema,
  prepareSchema,
  rankSitesSchema,
  toAgentIntent,
} from './schemas';

// =============================================================================
// understand
// =============================================================================

export interface UnderstandInput {
  request: string;
  /** The catalog's labels (the server adds them; local mode gets them via `/llm/payload`). */
  vocabulary?: string[];
  country?: string;
  locale?: string;
  timeZone?: string;
  now?: string;
}

/**
 * `understand-intent`: the request → its {@link AgentIntent} (six W's and
 * the selection mode), normalised by {@link toAgentIntent}.
 *
 * @throws when the model's answer has no usable intent.
 */
export async function understandIntent(
  ai: AiTransport,
  input: UnderstandInput
): Promise<AgentIntent> {
  const request = input.request.trim();
  const output = await ai.invoke('understand', {
    request,
    ...(input.vocabulary ? { vocabulary: input.vocabulary } : {}),
    ...(input.country ? { country: input.country } : {}),
    ...(input.locale ? { locale: input.locale } : {}),
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  try {
    return toAgentIntent(output, request);
  } catch {
    throw new Error('The model did not understand the request');
  }
}

// =============================================================================
// rank-sites
// =============================================================================

/** Most sites `rank-sites` keeps. */
export const MAX_RANKED_SITES = 12;

export interface RankSitesInput {
  request: string;
  intent: AgentIntent;
  country?: string;
  candidates: CandidateSite[];
}

/**
 * `rank-sites`: the label matches ordered best first, unsuitable ones left
 * out, each with a `reason`. Only sites from `candidates` survive (deduped,
 * at most {@link MAX_RANKED_SITES}). An answer that does not parse keeps the
 * candidates' own order.
 */
export async function rankSites(
  ai: AiTransport,
  input: RankSitesInput
): Promise<CandidateSite[]> {
  if (input.candidates.length === 0) return [];
  const byHost = new Map(input.candidates.map(c => [c.apiHost, c]));
  const output = await ai.invoke('rank-sites', {
    request: input.request,
    intent: input.intent,
    ...(input.country ? { country: input.country } : {}),
    sites: input.candidates.map(c => ({
      apiHost: c.apiHost,
      title: c.title,
      description: c.description,
      labels: c.labels,
      toolCount: c.toolCount,
    })),
  });
  const parsed = rankSitesSchema.safeParse(output);
  if (!parsed.success) return input.candidates.slice(0, MAX_RANKED_SITES);
  const seen = new Set<string>();
  const ranked: CandidateSite[] = [];
  for (const { apiHost, reason } of parsed.data.sites) {
    const site = byHost.get(apiHost);
    if (!site || seen.has(apiHost)) continue;
    seen.add(apiHost);
    ranked.push(reason ? { ...site, reason } : site);
    if (ranked.length >= MAX_RANKED_SITES) break;
  }
  return ranked;
}

// =============================================================================
// prepare
// =============================================================================

/** Most fields the merged form holds. */
export const MAX_MERGED_FIELDS = 12;

/**
 * One form from several sites' fields: deduped by name (the first site's
 * field wins, options are the union, required if any site requires it),
 * capped at {@link MAX_MERGED_FIELDS}.
 */
export function mergeForm(fieldLists: FormField[][]): FormField[] {
  const merged: FormField[] = [];
  const byName = new Map<string, FormField>();
  for (const fields of fieldLists) {
    for (const field of fields) {
      const existing = byName.get(field.name);
      if (!existing) {
        if (merged.length >= MAX_MERGED_FIELDS) continue;
        const copy: FormField = {
          ...field,
          ...(field.options ? { options: [...field.options] } : {}),
        };
        byName.set(field.name, copy);
        merged.push(copy);
        continue;
      }
      if (field.required) existing.required = true;
      if (existing.options && field.options) {
        for (const option of field.options) {
          if (!existing.options.some(o => o.value === option.value))
            existing.options.push(option);
        }
      }
    }
  }
  return merged;
}

export interface PrepareSitesInput {
  request: string;
  intent: AgentIntent;
  location?: GeoLocation;
  /** apiHosts the user chose. */
  sites: string[];
}

/** Most tools shown to `prepare` per site. */
export const MAX_PREPARE_TOOLS = 40;

/**
 * `prepare-site` for each chosen site (at most 4 at a time): which tools to
 * call, whether to sign in, which inputs to ask for; then one merged form.
 *
 * - tools the model names that the site does not have are dropped (at most
 *   {@link MAX_PREPARED_TOOLS}); none left → the 3 best-ranked tools;
 * - a site whose manifest needs no credential (`auth.style: 'none'`) never
 *   asks to sign in;
 * - a site the model calls `unsupported`, or whose context cannot be
 *   loaded, is reported with `unsupported` set and left out of the form;
 * - an answer that does not parse gives the 3 best-ranked tools, sign-in
 *   `fallback` when any of them needs the user, and no fields.
 *
 * Model transport errors are thrown (the caller decides about fallbacks).
 */
export async function prepareSites(
  ai: AiTransport,
  catalog: SiteContextSource | SiteCatalog,
  input: PrepareSitesInput
): Promise<PrepareResponse> {
  const hosts = [...new Set(input.sites)];
  const plans: Array<{ plan: SitePlan; fields: FormField[] }> = new Array(
    hosts.length
  );
  const queue = hosts.map((apiHost, index) => ({ apiHost, index }));
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      plans[next.index] = await prepareSite(ai, catalog, input, next.apiHost);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, hosts.length) }, worker));
  return {
    sites: plans.map(p => p.plan),
    form: mergeForm(plans.filter(p => !p.plan.unsupported).map(p => p.fields)),
  };
}

async function prepareSite(
  ai: AiTransport,
  catalog: SiteContextSource | SiteCatalog,
  input: PrepareSitesInput,
  apiHost: string
): Promise<{ plan: SitePlan; fields: FormField[] }> {
  let context;
  try {
    context = await loadSiteContext(catalog, apiHost);
  } catch {
    return {
      plan: {
        apiHost,
        title: apiHost,
        tools: [],
        login: 'none',
        unsupported: 'This site could not be loaded',
      },
      fields: [],
    };
  }
  const { manifest, toolAuth } = context;
  const ranked = rankTools(
    manifest.tools,
    `${input.request} ${input.intent.query}`
  ).slice(0, MAX_PREPARE_TOOLS);
  const auth = (name: string): ToolAuth | 'unknown' =>
    toolAuth[name] ?? 'unknown';
  const output = await ai.invoke('prepare', {
    request: input.request,
    intent: input.intent,
    ...(input.intent.location_needed && input.location
      ? { location: input.location }
      : {}),
    site: {
      apiHost,
      title: manifest.title,
      description: manifest.description,
    },
    tools: ranked.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      auth: auth(t.name),
    })),
  });
  const known = new Set(manifest.tools.map(t => t.name));
  const parsed = prepareSchema.safeParse(output);
  const noCredential = manifest.auth.style === 'none';

  if (!parsed.success) {
    const tools = ranked.slice(0, 3).map(t => t.name);
    const login =
      !noCredential && tools.some(t => auth(t) === 'user')
        ? 'fallback'
        : 'none';
    return {
      plan: { apiHost, title: manifest.title, tools, login },
      fields: [],
    };
  }
  const answer = parsed.data;
  let tools = [...new Set(answer.tools.filter(t => known.has(t)))].slice(
    0,
    MAX_PREPARED_TOOLS
  );
  if (tools.length === 0) tools = ranked.slice(0, 3).map(t => t.name);
  const login = noCredential ? 'none' : answer.login;
  const plan: SitePlan = {
    apiHost,
    title: manifest.title,
    tools,
    login,
    ...(login !== 'none' && answer.loginReason
      ? { loginReason: answer.loginReason }
      : {}),
    ...(answer.unsupported ? { unsupported: answer.unsupported } : {}),
  };
  return { plan, fields: answer.unsupported ? [] : answer.fields };
}

// =============================================================================
// pick-best
// =============================================================================

/** Most results `pick-best` compares. */
export const MAX_BEST_CANDIDATES = 40;

export interface PickBestInput {
  request: string;
  intent: AgentIntent;
  results: ResultItem[];
}

/**
 * `pick-best`: the one result that best answers the request. One result is
 * the best without asking; an unknown `bestId`, an answer that does not
 * parse or a model error falls back to the first result. Null only when
 * there are no results.
 */
export async function pickBest(
  ai: AiTransport,
  input: PickBestInput
): Promise<BestData | null> {
  const first = input.results[0];
  if (!first) return null;
  if (input.results.length === 1) return { resultId: first.id, reason: '' };
  const shown = input.results.slice(0, MAX_BEST_CANDIDATES);
  let output: unknown;
  try {
    output = await ai.invoke('pick-best', {
      request: input.request,
      intent: input.intent,
      results: shown.map(r => ({
        id: r.id,
        siteTitle: r.siteTitle,
        title: r.title,
        summary: r.summary,
        fields: r.fields,
      })),
    });
  } catch {
    return { resultId: first.id, reason: '' };
  }
  const parsed = pickBestSchema.safeParse(output);
  if (!parsed.success || !shown.some(r => r.id === parsed.data.bestId))
    return { resultId: first.id, reason: '' };
  return { resultId: parsed.data.bestId, reason: parsed.data.reason };
}
