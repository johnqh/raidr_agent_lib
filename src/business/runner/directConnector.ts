/**
 * Calls a site's API straight from the device, for local runs: the user's
 * site token goes from the device to the site and nowhere else (not through
 * raidr_api's hosted MCP proxy, not through raidr_agent_api).
 *
 * Same mapping and refusals as the hosted proxy, from raidr_types:
 * `buildUpstreamRequest` maps the tool call, `assertSafeUpstream` refuses the
 * URL before the token is attached to a request, redirects are not followed,
 * and the body is cut at `MAX_UPSTREAM_BYTES`. Every failure is returned as
 * `{ ok: false, text }` (never thrown), so the planner sees the reason.
 */
import {
  assertSafeUpstream,
  buildUpstreamRequest,
  MAX_UPSTREAM_BYTES,
  parseHttpUrl,
} from '@sudobility/raidr_types';
import type {
  SiteCatalog,
  SiteConnector,
  ToolCallResult,
  ToolSession,
} from './runner';

/** The part of a `fetch` response this connector reads. */
export interface FetchResponseLike {
  status: number;
  /** The final URL, when the runtime reports it. */
  url?: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/**
 * The `fetch` this connector needs: the platform `fetch`, `expo/fetch`, or a
 * test fake. Typed loosely so any of them fits without a cast.
 */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    redirect?: 'manual';
    signal?: AbortSignal;
  }
) => Promise<FetchResponseLike>;

export interface DirectSiteConnectorOptions {
  /** Manifests (from `GET /sites/:apiHost/manifest`, cached by the caller). */
  catalog: SiteCatalog;
  fetch: FetchLike;
  /** Development only: allow plain http to localhost. Never in a release build. */
  allowLocalhost?: boolean;
  /** Per call (default 30 s). */
  timeoutMs?: number;
  /** Body cap in characters (default `MAX_UPSTREAM_BYTES`). */
  maxBytes?: number;
}

export class DirectSiteConnector implements SiteConnector {
  constructor(private readonly options: DirectSiteConnectorOptions) {}

  async open(apiHost: string, token?: string): Promise<ToolSession> {
    const manifest = await this.options.catalog.manifest(apiHost);
    if (manifest.apiHost.toLowerCase() !== apiHost.toLowerCase()) {
      throw new Error(`Manifest for ${apiHost} names ${manifest.apiHost}`);
    }
    const toolByName = new Map(manifest.tools.map(t => [t.name, t]));
    const {
      fetch,
      allowLocalhost = false,
      timeoutMs = 30_000,
      maxBytes = MAX_UPSTREAM_BYTES,
    } = this.options;
    const fail = (text: string, httpStatus?: number): ToolCallResult => ({
      ok: false,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      text,
    });

    return {
      async callTool(name, args) {
        const tool = toolByName.get(name);
        if (!tool) return fail(`Unknown tool ${name}`);
        let request;
        try {
          request = buildUpstreamRequest(manifest, tool, args, token);
          // Checked before fetch so the token is never sent to a refused host.
          assertSafeUpstream(request.url, manifest, { allowLocalhost });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }

        const controller =
          typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller
          ? setTimeout(() => controller.abort(), timeoutMs)
          : null;
        try {
          const response = await fetch(request.url, {
            method: request.method,
            headers: request.headers,
            ...(request.body !== undefined ? { body: request.body } : {}),
            // A 3xx could carry the token to a host the manifest never named.
            redirect: 'manual',
            ...(controller ? { signal: controller.signal } : {}),
          });
          const { status } = response;
          if (status === 0 || (status >= 300 && status < 400)) {
            const location =
              response.headers.get('location') ?? '(no location)';
            return fail(
              `HTTP ${status}: upstream redirected to ${location}. Redirects are not followed.`,
              status || undefined
            );
          }
          // A runtime that followed a redirect anyway: do not use what came back.
          const finalHost = response.url
            ? parseHttpUrl(response.url)?.host
            : null;
          const requestHost = parseHttpUrl(request.url)?.host;
          if (finalHost && finalHost !== requestHost) {
            return fail(
              `HTTP ${status}: upstream redirected to ${finalHost}. Redirects are not followed.`
            );
          }
          const body = await response.text();
          const text = body.length > maxBytes ? body.slice(0, maxBytes) : body;
          return {
            ok: status >= 200 && status < 300,
            httpStatus: status,
            text,
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return fail(`Upstream request failed: ${message}`);
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
      close: async () => undefined,
    };
  }
}
