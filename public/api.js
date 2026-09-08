// public/api.js
//
// API session layer for the Trebuchet frontend. Installs a fetch wrapper
// that attaches the x-trebuchet-session header to same-origin /api/*
// requests. Extracted from app.js so the fetch interception can be tested
// independently of the full UI.
//
// Must be loaded before app.js in index.html.

(function () {
  const originalFetch = window.fetch.bind(window);
  let apiSessionTokenPromise = null;

  function isLocalApiRequest(input) {
    const raw = typeof input === 'string' ? input : input?.url;
    if (!raw) return false;
    const url = new URL(raw, window.location.href);
    return (
      url.origin === window.location.origin &&
      url.pathname.startsWith('/api/') &&
      url.pathname !== '/api/session'
    );
  }

  async function getApiSessionToken() {
    if (!apiSessionTokenPromise) {
      apiSessionTokenPromise = originalFetch('/api/session', {
        credentials: 'same-origin',
      })
        .then((r) => {
          if (!r.ok) throw new Error('API session failed: HTTP ' + r.status);
          return r.json();
        })
        .then((data) => {
          if (!data?.token) throw new Error('API session response missing token');
          return data.token;
        });
    }
    return apiSessionTokenPromise;
  }

  // Exposed so EventSource callers (which can't set custom headers)
  // can pass the session token as a query parameter instead.
  window.getApiSessionToken = getApiSessionToken;

  // A 403 "invalid API session" means the server's token changed under us
  // (restart, redeploy). Forget the cached token, fetch a fresh one, and
  // retry once. Request bodies that are streams can't be replayed, but the
  // app only sends JSON strings and FormData, which can.
  async function withSession(input, init, retry) {
    const headers = new Headers(
      init.headers || (input instanceof Request ? input.headers : undefined),
    );
    headers.set('x-trebuchet-session', await getApiSessionToken());
    const res = await originalFetch(input, { ...init, headers: headers });
    if (res.status === 403 && retry) {
      let body = null;
      try { body = await res.clone().json(); } catch (_) { /* not JSON */ }
      if (body && /invalid api session/i.test(String(body.error || ''))) {
        apiSessionTokenPromise = null;
        return withSession(input, init, false);
      }
    }
    return res;
  }

  window.fetch = async function (input, init) {
    init = init || {};
    if (!isLocalApiRequest(input)) return originalFetch(input, init);
    return withSession(input, init, true);
  };
})();
