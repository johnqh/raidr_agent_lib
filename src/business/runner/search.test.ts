import { describe, expect, it } from 'vitest';
import type { CandidateSite, SearchHit } from '@sudobility/raidr_agent_types';
import { hitOrigin, mergeSearchCandidates, searchOrigins } from './index';

const site = (apiHost: string, origin: string): CandidateSite => ({
  apiHost,
  title: apiHost,
  description: '',
  labels: [],
  siteOrigins: [origin],
  toolCount: 3,
  authStyle: 'none',
});
const hit = (url: string): SearchHit => ({ url, title: url, snippet: '' });

describe('search results', () => {
  it('reads the origin of a result, nothing else', () => {
    expect(hitOrigin('https://www.ticketmaster.com/taylor-swift?x=1')).toBe(
      'https://www.ticketmaster.com'
    );
    expect(hitOrigin('http://Example.com:8080/a')).toBe(
      'http://example.com:8080'
    );
    expect(hitOrigin('https://user:pw@evil.com/')).toBeNull();
    expect(hitOrigin('javascript:alert(1)')).toBeNull();
  });

  it('lists distinct origins in result order, capped', () => {
    const hits = [
      hit('https://a.com/1'),
      hit('https://b.com/1'),
      hit('https://a.com/2'),
      hit('not a url'),
      hit('https://c.com/'),
    ];
    expect(searchOrigins(hits)).toEqual([
      'https://a.com',
      'https://b.com',
      'https://c.com',
    ]);
    expect(searchOrigins(hits, 2)).toEqual(['https://a.com', 'https://b.com']);
  });

  it('puts search finds first, once each, with their results attached', () => {
    const tm = site('app.ticketmaster.com', 'https://www.ticketmaster.com');
    const sh = site('api.stubhub.com', 'https://www.stubhub.com');
    const eb = site('www.eventbrite.com', 'https://www.eventbrite.com');
    const hits = [
      hit('https://www.ticketmaster.com/taylor-swift'),
      hit('https://ticketmaster.com/eras'),
      hit('https://www.stubhub.com/taylor-swift-tickets'),
    ];
    const merged = mergeSearchCandidates([tm], [eb, sh, tm], hits);
    expect(merged.map(s => s.apiHost)).toEqual([
      'app.ticketmaster.com',
      'www.eventbrite.com',
      'api.stubhub.com',
    ]);
    expect(merged[0]!.searchHits?.map(h => h.url)).toEqual([
      'https://www.ticketmaster.com/taylor-swift',
      'https://ticketmaster.com/eras',
    ]);
    expect(merged[1]!.searchHits).toBeUndefined();
    expect(merged[2]!.searchHits).toHaveLength(1);
  });
});
