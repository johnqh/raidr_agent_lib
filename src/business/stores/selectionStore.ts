/**
 * The site-selection screen's state: which candidate sites the user has
 * ticked, and which have a remembered token this session. The token values
 * themselves live in the device's secure storage, never here.
 */
import { create } from 'zustand';

export interface SelectionState {
  /** Ticked api hosts. */
  selected: Set<string>;
  /** Hosts that have a token available (from secure storage or a fresh sign-in). */
  authorized: Set<string>;
  toggle: (apiHost: string) => void;
  select: (apiHost: string, on: boolean) => void;
  setAuthorized: (apiHost: string, on: boolean) => void;
  /** Start a new request: clear ticks and authorizations. */
  reset: () => void;
}

export const useSelectionStore = create<SelectionState>(set => ({
  selected: new Set<string>(),
  authorized: new Set<string>(),
  toggle: apiHost =>
    set(state => {
      const selected = new Set(state.selected);
      if (selected.has(apiHost)) selected.delete(apiHost);
      else selected.add(apiHost);
      return { selected };
    }),
  select: (apiHost, on) =>
    set(state => {
      const selected = new Set(state.selected);
      if (on) selected.add(apiHost);
      else selected.delete(apiHost);
      return { selected };
    }),
  setAuthorized: (apiHost, on) =>
    set(state => {
      const authorized = new Set(state.authorized);
      if (on) authorized.add(apiHost);
      else {
        authorized.delete(apiHost);
      }
      return { authorized };
    }),
  reset: () =>
    set({ selected: new Set<string>(), authorized: new Set<string>() }),
}));
