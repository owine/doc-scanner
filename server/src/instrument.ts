// Error reporting (Sentry protocol → GlitchTip). Imported FIRST by index.ts:
// ES modules evaluate in import order, so this runs before any other app
// module does. No-op unless SENTRY_DSN is set; see docs/observability.md.
import { initSentry } from './observability/sentry.js';

initSentry();
