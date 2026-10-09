/**
 * The optional web search before site ranking: which origins its results
 * point at, and how its finds join the label-matched candidates. Pure and
 * RN-safe (no `URL` class); the search itself runs in raidr_agent_api.
 */
import { parseHttpUrl } from '@sudobility/raidr_types';
import type { CandidateSite, SearchHit } from '@sudobility/raidr_agent_types';
import { isOnSite } from './pageUrl';

/** Most search results used. */
export const MAX_SEARCH_HITS = 10;
/** Most search results attached to one candidate. */
export const MAX_HITS_PER_SITE = 3;

/** `https://www.example.com` for an absolute http(s) URL without credentials, else null. */
export function hitOrigin(url: string): string | null {
  const parsed = parseHttpUrl(url);
  if (!parsed || parsed.hasCredentials) return null;
  return `${parsed.protocol}://${parsed.host}`;
}

/** The distinct origins of `hits`, in result order, at most `max`. */
export function searchOrigins(
  hits: SearchHit[],
  max = MAX_SEARCH_HITS
): string[] {
  const out: string[] = [];
  for (const hit of hits) {
    const origin = hitOrigin(hit.url);
    if (origin && !out.includes(origin)) out.push(origin);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Search-found candidates first (they have the specific thing asked for),
 * then the label matches, each apiHost once; then every candidate whose site
 * the results land on gets those results as `searchHits` (at most
 * {@link MAX_HITS_PER_SITE}), so `rank-sites` can see them.
 */
export function mergeSearchCandidates(
  searchFound: CandidateSite[],
  labelFound: CandidateSite[],
  hits: SearchHit[]
): CandidateSite[] {
  const seen = new Set<string>();
  const merged: CandidateSite[] = [];
  for (const site of [...searchFound, ...labelFound]) {
    if (seen.has(site.apiHost)) continue;
    seen.add(site.apiHost);
    const onSite = hits
      .filter(h => isOnSite(h.url, site.siteOrigins))
      .slice(0, MAX_HITS_PER_SITE);
    merged.push(onSite.length > 0 ? { ...site, searchHits: onSite } : site);
  }
  return merged;
}
