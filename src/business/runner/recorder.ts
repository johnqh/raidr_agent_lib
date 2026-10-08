/**
 * Records a local run from the same parts the runner streams, so it can be
 * uploaded to `POST /runs/import` for History when it ends. Holds no token:
 * the parts never carry one.
 */
import {
  type AgentIntent,
  type BestData,
  type CallData,
  type ResultGroup,
  type ResultItem,
  RUN_IMPORT_LIMITS,
  type RunImportRequest,
  type SiteRunStatus,
} from '@sudobility/raidr_agent_types';
import type { RunPart, RunWriter } from './runner';

export interface LocalRunRecorderOptions {
  request: string;
  intent: AgentIntent;
  /** Parts are passed on to this writer too (e.g. the UI's). */
  forward?: RunWriter;
  /** Clock, for tests. */
  now?: () => Date;
}

export interface LocalRunRecorder {
  /** Give this to `runSites` (it forwards every part). */
  writer: RunWriter;
  /**
   * The upload body. `status` defaults to `done`. Sites that never reached
   * `done`/`failed` are reported failed; calls still running are dropped;
   * calls and results are capped at {@link RUN_IMPORT_LIMITS}; `best` is
   * kept only when its result is among the uploaded ones.
   */
  toImportRequest(status?: 'done' | 'failed'): RunImportRequest;
}

export function createLocalRunRecorder(
  options: LocalRunRecorderOptions
): LocalRunRecorder {
  const now = options.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const sites = new Map<string, { status: SiteRunStatus; message?: string }>();
  const calls = new Map<string, CallData>();
  const results = new Map<string, ResultItem>();
  let best: BestData | null = null;
  let groups: ResultGroup[] = [];

  const record = (part: RunPart) => {
    switch (part.type) {
      case 'data-site-status':
        sites.set(part.data.apiHost, {
          status: part.data.status,
          ...(part.data.message !== undefined
            ? { message: part.data.message }
            : {}),
        });
        break;
      case 'data-call':
        calls.set(part.data.callId, part.data);
        break;
      case 'data-result':
        results.set(part.data.id, part.data);
        break;
      case 'data-best':
        best = part.data;
        break;
      case 'data-groups':
        groups = part.data.groups;
        break;
      default:
        break;
    }
  };

  return {
    writer: {
      write(part) {
        record(part);
        options.forward?.write(part);
      },
    },
    toImportRequest(status = 'done') {
      const kept = [...results.values()].slice(0, RUN_IMPORT_LIMITS.results);
      const chosen = best;
      return {
        request: options.request,
        intent: options.intent,
        status,
        createdAt,
        finishedAt: now().toISOString(),
        sites: [...sites.entries()]
          .slice(0, RUN_IMPORT_LIMITS.sites)
          .map(([apiHost, s]) =>
            s.status === 'done'
              ? { apiHost, status: 'done' as const }
              : {
                  apiHost,
                  status: 'failed' as const,
                  error:
                    s.status === 'failed'
                      ? (s.message ?? 'Failed')
                      : 'Did not finish',
                }
          ),
        calls: [...calls.values()]
          .filter(c => c.status !== 'running')
          .slice(0, RUN_IMPORT_LIMITS.calls),
        results: kept,
        best:
          chosen && kept.some(r => r.id === chosen.resultId) ? chosen : null,
        // A group survives only with two or more of its results uploaded.
        groups: groups
          .map(g => ({
            members: g.members.filter(m => kept.some(r => r.id === m.resultId)),
          }))
          .filter(g => g.members.length > 1),
      };
    },
  };
}
