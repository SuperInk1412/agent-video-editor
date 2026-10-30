// Ordered route table for the engine's JSON API (docs/DESIGN-BACKEND-V2.md §10.4.3).
//
// `engine/server.js` creates one router, every `engine/routes/*.js` file
// registers its own paths into it, and a request is answered by the first entry
// whose method and path match. Adding an HTTP endpoint means adding a line to a
// feature file — never editing server.js or another feature's file.
//
// Deliberately dumb, because the old code was a straight `if` chain:
//   - entries are tried in registration order, so a feature that needs a more
//     specific pattern registers it before the generic one;
//   - a handler is `(req, res, { url, pathname, params }) => any`; server.js
//     awaits it inside its own try/catch, so a throw becomes exactly the JSON
//     error response (and the log line) it always did;
//   - `any(path, handler)` keeps the two method-agnostic routes (/api/events
//     and /api/state) as method-agnostic as they were;
//   - `getMatch` / `postMatch` take one RegExp and hand its exec result to the
//     handler as `params` (params[1] is the captured id).

const isRegex = (value) => value instanceof RegExp;

export function createRouter() {
  const routes = [];
  const add = (method, path, handler) => {
    if (typeof handler !== 'function') throw new TypeError(`route ${method} ${String(path)} needs a handler`);
    if (typeof path !== 'string' && !isRegex(path)) throw new TypeError(`route ${method} needs a path or RegExp`);
    routes.push({ method, path, handler });
  };

  return {
    get: (path, handler) => add('GET', path, handler),
    post: (path, handler) => add('POST', path, handler),
    /** any HTTP method, like the two routes that never checked one */
    any: (path, handler) => add('*', path, handler),
    getMatch: (pattern, handler) => add('GET', pattern, handler),
    postMatch: (pattern, handler) => add('POST', pattern, handler),

    /** First match, or null. Throws only for malformed arguments. */
    match(method, pathname) {
      for (const route of routes) {
        if (route.method !== '*' && route.method !== method) continue;
        if (typeof route.path === 'string') {
          if (route.path === pathname) return { handler: route.handler, params: [] };
          continue;
        }
        const params = route.path.exec(pathname);
        if (params) return { handler: route.handler, params };
      }
      return null;
    },

    /** Registration order, for tests and diagnostics: [{ method, path }]. */
    list: () => routes.map((route) => ({
      method: route.method,
      path: typeof route.path === 'string' ? route.path : String(route.path),
    })),
  };
}
