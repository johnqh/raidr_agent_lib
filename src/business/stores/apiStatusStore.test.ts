import { beforeEach, describe, expect, it } from 'vitest';
import { useApiStatusStore } from './apiStatusStore';

describe('useApiStatusStore', () => {
  beforeEach(() => {
    useApiStatusStore.getState().reset();
  });

  it('starts empty', () => {
    const state = useApiStatusStore.getState();
    expect(state.lastHealth).toBeNull();
    expect(state.lastCheckedAt).toBeNull();
  });

  it('records the last health result', () => {
    useApiStatusStore.getState().setHealth({ status: 'ok', version: '0.0.1' });
    const state = useApiStatusStore.getState();
    expect(state.lastHealth).toEqual({ status: 'ok', version: '0.0.1' });
    expect(typeof state.lastCheckedAt).toBe('number');
  });

  it('reset clears state', () => {
    useApiStatusStore.getState().setHealth({ status: 'ok', version: '0.0.1' });
    useApiStatusStore.getState().reset();
    expect(useApiStatusStore.getState().lastHealth).toBeNull();
  });
});
