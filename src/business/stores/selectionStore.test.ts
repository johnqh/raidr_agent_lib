import { describe, expect, it, beforeEach } from 'vitest';
import { useSelectionStore } from './selectionStore';

describe('selectionStore', () => {
  beforeEach(() => useSelectionStore.getState().reset());

  it('toggles and records authorization independently', () => {
    const s = () => useSelectionStore.getState();
    s().toggle('a.com');
    s().toggle('b.com');
    s().toggle('a.com');
    expect([...s().selected]).toEqual(['b.com']);
    s().setAuthorized('b.com', true);
    expect(s().authorized.has('b.com')).toBe(true);
    s().reset();
    expect(s().selected.size).toBe(0);
    expect(s().authorized.size).toBe(0);
  });
});
