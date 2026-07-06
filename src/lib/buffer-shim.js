// Browser Buffer polyfill — a bundled transitive dep (jsonparse via
// JSONStream) references Node's Buffer at module-init; esbuild's browser
// target does not provide it. Injected globally so the bundle loads.
import { Buffer } from 'buffer';
export { Buffer };
