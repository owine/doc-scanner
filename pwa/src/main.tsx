import { initSentry } from './observability/sentry.js';
import './theme/theme.css';
import { render } from 'preact';
import { App } from './ui/App.js';

// Before render, so errors during the first render are caught. No-op unless
// VITE_SENTRY_DSN was set at build time; see docs/observability.md.
initSentry();

render(<App />, document.getElementById('app')!);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW register failed', e));
}
