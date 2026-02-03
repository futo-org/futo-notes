import { AppState } from './types';

type Listener = (state: AppState) => void;

const initialState: AppState = {
  notes: [],
  searchQuery: '',
  currentRoute: '/',
  routeParams: {}
};

let state = { ...initialState };
const listeners = new Set<Listener>();

export const store = {
  getState: () => state,

  setState: (partial: Partial<AppState>) => {
    state = { ...state, ...partial };
    listeners.forEach(fn => fn(state));
  },

  subscribe: (listener: Listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
};
