import { initSentry } from './observability/sentry.js';
import './theme/theme.css';
import { render } from 'preact';
import { App } from './ui/App.js';
import { registerSW } from './sw-register.js';
import { drain } from './outbox-drain.js';
import { ScansStore } from './scanner/scans-store.js';

// Before render, so errors during the first render are caught. No-op unless
// VITE_SENTRY_DSN was set at build time; see docs/observability.md.
initSentry();

render(<App />, document.getElementById('app')!);

// Slice 4: lazy-init a single ScansStore for the drain trigger. App holds
// its own instance for the UI; sharing the underlying IDB is fine — both
// instances open the same database.
let drainStore: ScansStore | null = null;
async function getDrainStore(): Promise<ScansStore> {
  if (!drainStore) {
    drainStore = new ScansStore();
    await drainStore.open();
  }
  return drainStore;
}

registerSW(async () => {
  try {
    const store = await getDrainStore();
    await drain({ fetch, store });
  } catch (e) {
    console.warn('outbox drain failed', e);
  }
});
