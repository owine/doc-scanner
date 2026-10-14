import { initSentry } from './observability/sentry.js';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './theme/tokens.css';
import './theme/base.css';
import './theme/auth.css';
import './theme/inbox.css';
import './theme/settings.css';
import { render } from 'preact';
import { App } from './ui/App.js';
import { warmServiceWorkerCache } from './sw-warm.js';

// Before render, so errors during the first render are caught. No-op unless
// VITE_SENTRY_DSN was set at build time; see docs/observability.md.
initSentry();

render(<App />, document.getElementById('app')!);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW register failed', e));
  // On a first visit, chunks load before the worker controls the page: have it cache them once it does.
  warmServiceWorkerCache();
}
