const API_ORIGIN = 'https://prod-api.fomo.family';

// Observe JSON the website already consumes. Never wrap fetch: doing so makes
// unrelated website CSP violations appear as extension runtime errors.
export function observeFomoResponses(onResponse: (url: URL, body: unknown) => void) {
  const originalJson = Response.prototype.json;
  const observedJson = function (this: Response) {
    const result = originalJson.call(this);
    try {
      const url = new URL(this.url);
      const allowed = url.origin === API_ORIGIN && (
        url.pathname === '/v2/users' || url.pathname === '/config' ||
        url.pathname === '/proxy/filterTokens' || /^\/v2\/users\/[^/]+\/balances$/.test(url.pathname)
      );
      if (this.ok && allowed) {
        // Keep the website's original promise, response and rejection intact.
        // Parsing failures or observer errors must not create a second rejection.
        void result.then(body => onResponse(url, body)).catch(() => {});
      }
    } catch { /* Non-URL synthetic responses are not FOMO API responses. */ }
    return result;
  };
  Response.prototype.json = observedJson;
  return () => { if (Response.prototype.json === observedJson) Response.prototype.json = originalJson; };
}
