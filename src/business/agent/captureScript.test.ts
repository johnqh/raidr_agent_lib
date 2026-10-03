import { describe, expect, it, beforeEach, vi } from 'vitest';
import { buildCaptureScript, type ObservedRequest } from './captureScript';

/** Run the injected script against fake fetch/XHR and a message bridge. */
function harness(apiHost: string) {
  const posted: unknown[] = [];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const win: any = {
    location: { href: 'https://site.example/' },
    ReactNativeWebView: {
      postMessage: (s: string) => posted.push(JSON.parse(s)),
    },
    fetch: (input: any, init?: RequestInit) => {
      calls.push({ url: typeof input === 'string' ? input : input.url, init });
      const status = String(input).includes('/me') ? 200 : 200;
      return Promise.resolve({ status });
    },
    URL,
    Headers,
  };
  class FakeXHR {
    status = 0;
    private listeners: Record<string, Array<() => void>> = {};
    open(_m: string, _u: string) {}
    setRequestHeader(_n: string, _v: string) {}
    send() {}
    addEventListener(e: string, cb: () => void) {
      (this.listeners[e] ||= []).push(cb);
    }
    fire(e: string) {
      (this.listeners[e] || []).forEach(cb => cb());
    }
  }
  win.XMLHttpRequest = FakeXHR;
  // eslint-disable-next-line no-new-func
  new Function(
    'window',
    'XMLHttpRequest',
    'Headers',
    'URL',
    buildCaptureScript(apiHost)
  )(win, FakeXHR, Headers, URL);
  return { win, posted, calls, FakeXHR };
}

describe('buildCaptureScript', () => {
  it('reports fetches to the api host with their request headers, ignores others', async () => {
    const { win, posted } = harness('api.example.com');
    await win.fetch('https://api.example.com/api/me', {
      method: 'GET',
      headers: { Authorization: 'Bearer tok' },
    });
    await win.fetch('https://cdn.other.com/x.js');
    await new Promise(r => setTimeout(r, 0));
    const observed = posted.filter(
      (p): p is ObservedRequest =>
        (p as any).kind === 'raidr-agent/observed-request'
    );
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      url: 'https://api.example.com/api/me',
      method: 'GET',
      status: 200,
      headers: { authorization: 'Bearer tok' },
    });
  });

  it('reports XHRs to the api host on loadend', () => {
    const { win, posted } = harness('api.example.com');
    const xhr = new win.XMLHttpRequest();
    xhr.open('GET', 'https://api.example.com/api/orders/9');
    xhr.setRequestHeader('Authorization', 'Bearer xhrtok');
    xhr.send();
    xhr.status = 200;
    xhr.fire('loadend');
    const observed = posted.filter(
      (p: any) => p.kind === 'raidr-agent/observed-request'
    );
    expect(observed[0]).toMatchObject({
      url: 'https://api.example.com/api/orders/9',
      headers: { authorization: 'Bearer xhrtok' },
    });
  });

  it('is safe against a host that contains quotes', () => {
    expect(() => harness('api.example.com"//evil')).not.toThrow();
  });
});
