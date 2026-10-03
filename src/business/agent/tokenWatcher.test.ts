import { describe, expect, it } from 'vitest';
import type { SiteAuthInfo } from '@sudobility/raidr_agent_types';
import { TokenWatcher } from './tokenWatcher';
import type { ObservedRequest } from './captureScript';

const bearer: SiteAuthInfo['auth'] = { style: 'bearer' };
const req = (url: string, status: number, token: string): ObservedRequest => ({
  kind: 'raidr-agent/observed-request',
  url,
  method: 'GET',
  status,
  headers: { authorization: `Bearer ${token}` },
});

describe('TokenWatcher', () => {
  it('accepts a token only once a signed-in-only call succeeds with it', () => {
    const w = new TokenWatcher('api.example.com', bearer, [
      '/api/me',
      '/api/orders/{id}',
    ]);
    expect(
      w.observe(req('https://api.example.com/api/feed', 200, 'guest'))
    ).toBeNull();
    expect(
      w.observe(req('https://api.example.com/api/me', 401, 'stale'))
    ).toBeNull();
    expect(
      w.observe(req('https://other.example.com/api/me', 200, 'x'))
    ).toBeNull();
    expect(
      w.observe(req('https://api.example.com/api/orders/9?x=1', 200, 'good'))
    ).toEqual({
      token: 'good',
      verified: true,
    });
  });

  it('drops a guest token when the window closes, since there is an endpoint to verify against', () => {
    const w = new TokenWatcher('api.example.com', bearer, ['/api/me']);
    w.observe(req('https://api.example.com/api/feed', 200, 'guest'));
    expect(w.onClosed()).toBeNull();
  });

  it('with no signed-in-only endpoints, any 2xx verifies and close returns the last unverified', () => {
    const w = new TokenWatcher('api.example.com', bearer, []);
    expect(w.observe(req('https://api.example.com/x', 500, 'seen'))).toBeNull();
    expect(w.onClosed()).toEqual({ token: 'seen', verified: false });
    expect(w.observe(req('https://api.example.com/x', 200, 'seen2'))).toEqual({
      token: 'seen2',
      verified: true,
    });
  });

  it('cookie tokens are accepted only after a signed-in call was seen', () => {
    const w = new TokenWatcher(
      'api.example.com',
      { style: 'cookie', cookieName: 'sid' },
      ['/api/me']
    );
    expect(w.observeCookieToken('abc', false)).toBeNull();
    expect(w.observeCookieToken('abc', true)).toEqual({
      token: 'abc',
      verified: true,
    });
  });
});
