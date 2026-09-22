/**
 * Browser replacement for `cross-fetch`: its browser build exports the native `fetch` as a bare reference, and calling
 * that detached from `window` throws "Illegal invocation". midnight-js providers import it, so alias it to bound versions.
 */
const f: typeof fetch = (...args) => globalThis.fetch(...args);
export default f;
export { f as fetch };
export const Headers = globalThis.Headers;
export const Request = globalThis.Request;
export const Response = globalThis.Response;
