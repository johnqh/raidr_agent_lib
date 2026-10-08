import { describe, expect, it } from 'vitest';
import type { McpManifest } from '@sudobility/raidr_types';
import type { AgentIntent } from '@sudobility/raidr_agent_types';
import { createLocalRunRecorder, runSites, type RunPart } from './index';

const intent: AgentIntent = {
  location_needed: false,
  intent: 'recipe',
  labels: ['recipes'],
  slots: [],
  resultKind: 'recipe',
  query: 'pad thai',
  what: 'find a recipe',
  who: null,
  how: null,
  when: null,
  where: null,
  why: null,
  selection: 'all',
};

describe('createLocalRunRecorder', () => {
  it('turns the parts of a run into an import request and forwards them', async () => {
    let t = Date.parse('2026-10-01T00:00:00.000Z');
    const forwarded: RunPart[] = [];
    const recorder = createLocalRunRecorder({
      request: 'pad thai recipe',
      intent,
      forward: { write: p => void forwarded.push(p) },
      now: () => new Date((t += 1000)),
    });
    const manifest = {
      apiHost: 'a.example',
      title: 'A',
      description: '',
      tools: [
        {
          name: 'search',
          description: '',
          inputSchema: { type: 'object' },
          request: { method: 'GET', pathTemplate: '/s' },
        },
      ],
    } as unknown as McpManifest;
    let planned = false;
    await runSites(
      {
        request: 'pad thai recipe',
        intent,
        sites: [
          { apiHost: 'a.example', token: 'tok' },
          { apiHost: 'b.example' },
        ],
      },
      recorder.writer,
      {
        ai: {
          invoke: async step => {
            if (step === 'plan') {
              if (planned) return { done: true, calls: [] };
              planned = true;
              return {
                done: false,
                calls: [{ tool: 'search', arguments: '{"q":"x"}' }],
              };
            }
            return { items: [{ title: 'Pad Thai', summary: 's' }] };
          },
        },
        catalog: {
          manifest: async h => {
            if (h === 'b.example') throw new Error('gone');
            return manifest;
          },
        },
        connector: {
          open: async () => ({
            callTool: async () => ({ ok: true, httpStatus: 200, text: '[]' }),
            close: async () => undefined,
          }),
        },
      },
      { concurrency: 1 }
    );

    const body = recorder.toImportRequest();
    expect(body).toMatchObject({
      request: 'pad thai recipe',
      intent,
      status: 'done',
      createdAt: '2026-10-01T00:00:01.000Z',
      sites: [
        { apiHost: 'a.example', status: 'done' },
        { apiHost: 'b.example', status: 'failed', error: 'gone' },
      ],
    });
    expect(Date.parse(body.finishedAt)).toBeGreaterThan(
      Date.parse(body.createdAt)
    );
    expect(body.calls).toHaveLength(1);
    expect(body.calls[0]).toMatchObject({
      apiHost: 'a.example',
      tool: 'search',
      status: 'ok',
      httpStatus: 200,
    });
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      id: 'a.example:0',
      title: 'Pad Thai',
    });
    expect(JSON.stringify(body)).not.toContain('tok"');
    expect(forwarded.length).toBeGreaterThan(5);
  });

  it('drops running calls and fails unfinished sites', () => {
    const recorder = createLocalRunRecorder({ request: 'r', intent });
    recorder.writer.write({
      type: 'data-site-status',
      id: 'site:a',
      data: { apiHost: 'a', title: 'a', status: 'calling' },
    });
    recorder.writer.write({
      type: 'data-call',
      id: 'call:1',
      data: {
        callId: '1',
        apiHost: 'a',
        tool: 't',
        arguments: {},
        status: 'running',
      },
    });
    const body = recorder.toImportRequest('failed');
    expect(body.status).toBe('failed');
    expect(body.sites).toEqual([
      { apiHost: 'a', status: 'failed', error: 'Did not finish' },
    ]);
    expect(body.calls).toEqual([]);
  });

  it('keeps best only when its result was uploaded', () => {
    const recorder = createLocalRunRecorder({ request: 'r', intent });
    const result = {
      id: 'a:0',
      apiHost: 'a',
      siteTitle: 'A',
      title: 't',
      summary: '',
      imageUrl: '',
      sourceUrl: '',
      pageUrl: 'https://a.example/0',
      recipe: null,
      fields: [],
    };
    recorder.writer.write({
      type: 'data-result',
      id: 'result:a:0',
      data: result,
    });
    recorder.writer.write({
      type: 'data-best',
      id: 'best',
      data: { resultId: 'a:0', reason: 'Only one' },
    });
    expect(recorder.toImportRequest().best).toEqual({
      resultId: 'a:0',
      reason: 'Only one',
    });
    recorder.writer.write({
      type: 'data-best',
      id: 'best',
      data: { resultId: 'zzz', reason: '' },
    });
    expect(recorder.toImportRequest().best).toBeNull();
  });

  it('keeps groups, dropping members whose result was not uploaded', () => {
    const recorder = createLocalRunRecorder({ request: 'r', intent });
    for (const id of ['a:0', 'b:0']) {
      recorder.writer.write({
        type: 'data-result',
        id: `result:${id}`,
        data: {
          id,
          apiHost: id[0]!,
          siteTitle: '',
          title: 't',
          summary: '',
          imageUrl: '',
          sourceUrl: '',
          pageUrl: '',
          recipe: null,
          fields: [],
        },
      });
    }
    expect(recorder.toImportRequest().groups).toEqual([]);
    const pair = {
      members: [
        { resultId: 'a:0', note: '$85' },
        { resultId: 'b:0', note: '$90' },
      ],
    };
    const ghost = {
      members: [
        { resultId: 'a:0', note: '' },
        { resultId: 'zzz', note: '' },
      ],
    };
    recorder.writer.write({
      type: 'data-groups',
      id: 'groups',
      data: { groups: [pair, ghost] },
    });
    expect(recorder.toImportRequest().groups).toEqual([pair]);
  });
});
