import { render } from 'preact';
import { App } from './ui/App.js';

render(<App />, document.getElementById('app')!);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW register failed', e));
}
