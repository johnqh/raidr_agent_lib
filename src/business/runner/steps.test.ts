import { describe, expect, it } from 'vitest';
import type { McpManifest, McpTool } from '@sudobility/raidr_types';
import type {
  AgentIntent,
  AgentStep,
  CandidateSite,
  FormField,
  ResultItem,
  SiteContext,
} from '@sudobility/raidr_agent_types';
import {
  type AiTransport,
  MAX_RANKED_SITES,
  mergeForm,
  pickBest,
  prepareSites,
  rankSites,
  type SiteContextSource,
  understandIntent,
} from './index';

function scripted(answers: Partial<Record<AgentStep, unknown>>) {
  const seen: Array<{ step: AgentStep; input: Record<string, unknown> }> = [];
  const ai: AiTransport = {
    async invoke(step, input) {
      seen.push({ step, input });
      const answer = answers[step];
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer(input) : answer;
    },
  };
  return { ai, seen };
}

const intent: AgentIntent = {
  location_needed: true,
  intent: 'event_search',
  labels: ['events'],
  slots: [],
  resultKind: 'generic',
  query: 'events tonight',
  what: 'find events',
  who: { kind: 'self' },
  how: null,
  when: {
    text: 'tonight',
    start: '2026-10-08T18:00:00-07:00',
    end: '2026-10-08T23:59:00-07:00',
  },
  where: { kind: 'current', places: [] },
  why: null,
  selection: 'all',
};

describe('understandIntent', () => {
  it('sends the device context and normalises the answer', async () => {
    const { ai, seen } = scripted({
      understand: {
        intent: 'event_search',
        labels: ['Events', 'nightlife', 'bad label!'],
        slots: [{ name: 'time', value: 'tonight' }],
        resultKind: 'generic',
        query: 'events tonight',
        what: 'find events',
        who: { kind: 'self' },
        how: null,
        when: {
          text: 'tonight',
          start: '2026-10-08T18:00:00-07:00',
          end: '2026-10-08T23:59:00-07:00',
        },
        where: { kind: 'current', places: [] },
        why: null,
        selection: 'all',
        location_needed: true,
      },
    });
    const result = await understandIntent(ai, {
      request: ' Find the events tonight ',
      vocabulary: ['events'],
      country: 'US',
      locale: 'en-US',
      timeZone: 'America/Los_Angeles',
      now: '2026-10-08T15:00:00-07:00',
    });
    expect(seen[0]).toEqual({
      step: 'understand',
      input: {
        request: 'Find the events tonight',
        vocabulary: ['events'],
        country: 'US',
        locale: 'en-US',
        timeZone: 'America/Los_Angeles',
        now: '2026-10-08T15:00:00-07:00',
      },
    });
    expect(result).toEqual({
      ...intent,
      labels: ['events', 'nightlife'],
      slots: [{ name: 'time', value: 'tonight' }],
    });
  });

  it("turns unusable W's into null and defaults the selection", async () => {
    const { ai } = scripted({
      understand: {
        intent: 'apartment_rental',
        labels: ['real-estate'],
        resultKind: 'place',
        query: '',
        who: { kind: 'robot' },
        how: '   ',
        when: { text: '', start: 'next tuesday' },
        where: { kind: 'place', places: [] },
        why: 42,
        selection: 'some',
      },
    });
    const result = await understandIntent(ai, { request: 'apartments' });
    expect(result).toMatchObject({
      intent: 'apartment_rental',
      query: 'apartments',
      what: 'apartment_rental',
      who: null,
      how: null,
      when: null,
      where: null,
      why: null,
      selection: 'all',
      location_needed: false,
    });
  });

  it('keeps a party, places and clamps the party size', async () => {
    const { ai } = scripted({
      understand: {
        intent: 'flight_booking',
        labels: ['travel'],
        resultKind: 'product',
        query: 'flights SFO to Paris',
        what: 'book a flight',
        who: { kind: 'party', partySize: 1000.4, description: '2 adults' },
        where: {
          kind: 'place',
          places: [
            { name: 'SFO', role: 'origin' },
            { name: 'Paris', role: 'moon' },
            { role: 'stop' },
          ],
        },
        when: { text: 'next friday', start: '2026-10-16' },
        selection: 'best',
      },
    });
    const result = await understandIntent(ai, { request: 'flights' });
    expect(result.who).toEqual({
      kind: 'party',
      partySize: 100,
      description: '2 adults',
    });
    expect(result.where).toEqual({
      kind: 'places',
      places: [{ name: 'SFO', role: 'origin' }, { name: 'Paris' }],
    });
    expect(result.when).toEqual({ text: 'next friday', start: '2026-10-16' });
    expect(result.selection).toBe('best');
  });

  it('location_needed without a place means the current location', async () => {
    const { ai } = scripted({
      understand: { intent: 'x', location_needed: true, where: null },
    });
    const result = await understandIntent(ai, { request: 'coffee near me' });
    expect(result.where).toEqual({ kind: 'current', places: [] });
    expect(result.location_needed).toBe(true);
  });

  it('throws when there is no intent', async () => {
    const { ai } = scripted({ understand: { labels: [] } });
    await expect(understandIntent(ai, { request: 'x' })).rejects.toThrow(
      'did not understand'
    );
  });
});

const candidate = (apiHost: string): CandidateSite => ({
  apiHost,
  title: apiHost.toUpperCase(),
  description: `about ${apiHost}`,
  labels: ['events'],
  siteOrigins: [`https://${apiHost}`],
  toolCount: 3,
  authStyle: 'none',
});

describe('rankSites', () => {
  it('keeps only known sites, in the model order, with reasons', async () => {
    const { ai, seen } = scripted({
      'rank-sites': {
        sites: [
          { apiHost: 'b.example', reason: 'Local events' },
          { apiHost: 'evil.example', reason: 'not a candidate' },
          { apiHost: 'a.example', reason: '' },
          { apiHost: 'b.example', reason: 'dup' },
          { nope: true },
        ],
      },
    });
    const ranked = await rankSites(ai, {
      request: 'events tonight',
      intent,
      country: 'US',
      candidates: [
        candidate('a.example'),
        candidate('b.example'),
        candidate('c.example'),
      ],
    });
    expect(ranked.map(s => s.apiHost)).toEqual(['b.example', 'a.example']);
    expect(ranked[0]!.reason).toBe('Local events');
    expect(ranked[1]!.reason).toBeUndefined();
    expect(seen[0]!.input).toMatchObject({
      country: 'US',
      sites: [
        {
          apiHost: 'a.example',
          title: 'A.EXAMPLE',
          labels: ['events'],
          toolCount: 3,
        },
        expect.anything(),
        expect.anything(),
      ],
    });
  });

  it('caps at 12 and keeps the candidate order when the answer is unusable', async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      candidate(`s${i}.example`)
    );
    const all = scripted({
      'rank-sites': {
        sites: many.map(s => ({ apiHost: s.apiHost, reason: 'ok' })),
      },
    });
    expect(
      await rankSites(all.ai, { request: 'r', intent, candidates: many })
    ).toHaveLength(MAX_RANKED_SITES);
    const broken = scripted({ 'rank-sites': 'nonsense' });
    const kept = await rankSites(broken.ai, {
      request: 'r',
      intent,
      candidates: many,
    });
    expect(kept.map(s => s.apiHost)).toEqual(
      many.slice(0, 12).map(s => s.apiHost)
    );
  });

  it('does not ask the model about no candidates', async () => {
    const { ai, seen } = scripted({});
    expect(
      await rankSites(ai, { request: 'r', intent, candidates: [] })
    ).toEqual([]);
    expect(seen).toHaveLength(0);
  });
});

const tool = (name: string, description = ''): McpTool =>
  ({
    name,
    description,
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    request: { method: 'GET', pathTemplate: `/${name}` },
  }) as McpTool;

function contextOf(
  apiHost: string,
  style: 'none' | 'bearer',
  toolAuth: SiteContext['toolAuth'] = {}
): SiteContext {
  return {
    manifest: {
      apiHost,
      title: `Site ${apiHost}`,
      description: 'desc',
      siteOrigins: [`https://${apiHost}`],
      auth: { style },
      tools: [
        tool('search_events', 'Search events'),
        tool('my_tickets'),
        tool('get_event'),
      ],
    } as unknown as McpManifest,
    toolAuth,
    routes: [],
  };
}

describe('prepareSites', () => {
  const catalog: SiteContextSource = {
    async context(apiHost) {
      if (apiHost === 'gone.example') throw new Error('404');
      return contextOf(
        apiHost,
        apiHost === 'open.example' ? 'none' : 'bearer',
        { search_events: 'user', my_tickets: 'user' }
      );
    },
  };

  it('plans each site, checks tools, forces no sign-in for auth none, merges the form', async () => {
    const { ai, seen } = scripted({
      prepare: (input: Record<string, unknown>) => {
        const site = (input.site as { apiHost: string }).apiHost;
        if (site === 'nope.example')
          return {
            tools: [],
            login: 'none',
            fields: [],
            unsupported: 'Only sells shoes',
          };
        return {
          tools: ['search_events', 'made_up', 'search_events', 'get_event'],
          login: 'fallback',
          loginReason: 'See events for members',
          fields: [
            {
              name: 'Category',
              label: 'Category',
              type: 'select',
              required: false,
              options: [{ value: site, label: site }],
            },
            {
              name: 'startDate',
              label: 'Start',
              type: 'date',
              required: site === 'open.example',
              default: '2026-10-08',
            },
            { name: '???', label: 'bad', type: 'text', required: true },
          ],
        };
      },
    });
    const result = await prepareSites(ai, catalog, {
      request: 'events tonight',
      intent,
      location: { latitude: 1, longitude: 2 },
      sites: ['events.example', 'open.example', 'nope.example', 'gone.example'],
    });
    expect(result.sites).toEqual([
      {
        apiHost: 'events.example',
        title: 'Site events.example',
        tools: ['search_events', 'get_event'],
        login: 'fallback',
        loginReason: 'See events for members',
      },
      {
        apiHost: 'open.example',
        title: 'Site open.example',
        tools: ['search_events', 'get_event'],
        login: 'none',
      },
      {
        apiHost: 'nope.example',
        title: 'Site nope.example',
        tools: ['search_events', 'my_tickets', 'get_event'],
        login: 'none',
        unsupported: 'Only sells shoes',
      },
      {
        apiHost: 'gone.example',
        title: 'gone.example',
        tools: [],
        login: 'none',
        unsupported: 'This site could not be loaded',
      },
    ]);
    expect(result.form).toEqual([
      {
        name: 'category',
        label: 'Category',
        type: 'select',
        required: false,
        options: [
          { value: 'events.example', label: 'events.example' },
          { value: 'open.example', label: 'open.example' },
        ],
      },
      {
        name: 'start_date',
        label: 'Start',
        type: 'date',
        required: true,
        default: '2026-10-08',
      },
    ]);
    const first = seen.find(
      s => (s.input.site as { apiHost: string }).apiHost === 'events.example'
    )!;
    expect(first.input.location).toEqual({ latitude: 1, longitude: 2 });
    expect(first.input.tools).toEqual([
      expect.objectContaining({ name: 'search_events', auth: 'user' }),
      expect.objectContaining({ name: 'my_tickets', auth: 'user' }),
      expect.objectContaining({ name: 'get_event', auth: 'unknown' }),
    ]);
  });

  it('falls back to the best-ranked tools when the answer is unusable', async () => {
    const { ai } = scripted({ prepare: { nothing: true } });
    const result = await prepareSites(ai, catalog, {
      request: 'events',
      intent: { ...intent, location_needed: false },
      sites: ['events.example'],
    });
    expect(result.sites[0]).toEqual({
      apiHost: 'events.example',
      title: 'Site events.example',
      tools: ['search_events', 'my_tickets', 'get_event'],
      login: 'fallback',
    });
    expect(result.form).toEqual([]);
  });

  it('works with a bare manifest catalog (no tool auth)', async () => {
    const { ai, seen } = scripted({
      prepare: { tools: ['get_event'], login: 'required', fields: [] },
    });
    const result = await prepareSites(
      ai,
      { manifest: async h => contextOf(h, 'bearer').manifest },
      { request: 'my tickets', intent, sites: ['events.example'] }
    );
    expect(result.sites[0]).toMatchObject({
      tools: ['get_event'],
      login: 'required',
    });
    expect((seen[0]!.input.tools as Array<{ auth: string }>)[0]!.auth).toBe(
      'unknown'
    );
  });

  it('passes model errors on', async () => {
    const { ai } = scripted({ prepare: new Error('provider down') });
    await expect(
      prepareSites(ai, catalog, {
        request: 'x',
        intent,
        sites: ['events.example'],
      })
    ).rejects.toThrow('provider down');
  });
});

describe('mergeForm', () => {
  const f = (over: Partial<FormField>): FormField => ({
    name: 'keyword',
    label: 'Keyword',
    type: 'text',
    required: false,
    ...over,
  });

  it('dedupes by name: first wins, options union, required if any', () => {
    const merged = mergeForm([
      [
        f({ label: 'Search' }),
        f({
          name: 'genre',
          type: 'multiselect',
          options: [{ value: 'rock', label: 'Rock' }],
        }),
      ],
      [
        f({ label: 'Other', required: true, default: 'x' }),
        f({
          name: 'genre',
          type: 'multiselect',
          options: [
            { value: 'rock', label: 'ROCK' },
            { value: 'jazz', label: 'Jazz' },
          ],
        }),
      ],
    ]);
    expect(merged).toEqual([
      f({ label: 'Search', required: true }),
      f({
        name: 'genre',
        type: 'multiselect',
        options: [
          { value: 'rock', label: 'Rock' },
          { value: 'jazz', label: 'Jazz' },
        ],
      }),
    ]);
  });

  it('does not mutate its input and caps the form', () => {
    const options = [{ value: 'a', label: 'A' }];
    const first = [f({ name: 's', type: 'select', options })];
    mergeForm([
      first,
      [f({ name: 's', type: 'select', options: [{ value: 'b', label: 'B' }] })],
    ]);
    expect(options).toHaveLength(1);
    const many = Array.from({ length: 30 }, (_, i) => f({ name: `f${i}` }));
    expect(mergeForm([many])).toHaveLength(12);
  });
});

describe('pickBest', () => {
  const result = (id: string): ResultItem => ({
    id,
    apiHost: 'a',
    siteTitle: 'A',
    title: `T ${id}`,
    summary: '',
    imageUrl: '',
    sourceUrl: '',
    pageUrl: '',
    recipe: null,
    fields: [{ label: 'Price', value: '$1' }],
  });

  it('asks the model and checks its answer', async () => {
    const { ai, seen } = scripted({
      'pick-best': { bestId: 'b', reason: 'Cheapest' },
    });
    expect(
      await pickBest(ai, {
        request: 'r',
        intent,
        results: [result('a'), result('b')],
      })
    ).toEqual({ resultId: 'b', reason: 'Cheapest' });
    expect(seen[0]!.input.results).toEqual([
      {
        id: 'a',
        siteTitle: 'A',
        title: 'T a',
        summary: '',
        fields: [{ label: 'Price', value: '$1' }],
      },
      expect.objectContaining({ id: 'b' }),
    ]);
  });

  it('falls back to the first result', async () => {
    const results = [result('a'), result('b')];
    for (const answer of [
      { bestId: 'zzz', reason: 'x' },
      'garbage',
      new Error('down'),
    ]) {
      const { ai } = scripted({ 'pick-best': answer });
      expect(await pickBest(ai, { request: 'r', intent, results })).toEqual({
        resultId: 'a',
        reason: '',
      });
    }
  });

  it('one result is the best without asking; none is null', async () => {
    const { ai, seen } = scripted({});
    expect(
      await pickBest(ai, { request: 'r', intent, results: [result('x')] })
    ).toEqual({
      resultId: 'x',
      reason: '',
    });
    expect(
      await pickBest(ai, { request: 'r', intent, results: [] })
    ).toBeNull();
    expect(seen).toHaveLength(0);
  });
});
