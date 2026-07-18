/**
 * ops-widget auth worker — GitHub OAuth token exchange.
 *
 * WHY THIS EXISTS
 * GitHub does not support PKCE, and its OAuth endpoints send no CORS headers.
 * A browser therefore cannot complete a GitHub sign-in by itself: the final
 * code->token swap must be made by something that holds the client secret.
 * This Worker is that something, and nothing more.
 *
 * WHAT IT DOES NOT DO
 *  - does not store tokens (no KV, no D1, no cache, no state of any kind)
 *  - does not log tokens, codes, or request bodies
 *  - is never called again after sign-in: all GitHub API traffic goes
 *    browser -> api.github.com directly
 *
 * The token exists here only as a local variable, for the duration of one
 * request. This file is public so that claim is auditable.
 */

const ALLOWED_ORIGINS = new Set([
  'https://gbx-ai.github.io',
  'http://localhost:8080',
]);

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function corsHeaders(origin) {
  if (!ALLOWED_ORIGINS.has(origin)) return null;
  return {
    ...JSON_HEADERS,
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const fail = (status, error, headers) =>
  new Response(JSON.stringify({ error }), { status, headers: headers || JSON_HEADERS });

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return cors
        ? new Response(null, { status: 204, headers: cors })
        : fail(403, 'origin_not_allowed');
    }
    /* An unknown origin must never reach the secret. */
    if (!cors) return fail(403, 'origin_not_allowed');
    if (request.method !== 'POST') return fail(405, 'method_not_allowed', cors);

    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      return fail(500, 'worker_not_configured', cors);
    }

    let body;
    try { body = await request.json(); }
    catch { return fail(400, 'invalid_json', cors); }

    const form = {
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
    };

    if (new URL(request.url).pathname.endsWith('/refresh')) {
      if (!body.refresh_token) return fail(400, 'missing_refresh_token', cors);
      form.grant_type = 'refresh_token';
      form.refresh_token = body.refresh_token;
    } else {
      if (!body.code) return fail(400, 'missing_code', cors);
      form.code = body.code;
      if (body.redirect_uri) form.redirect_uri = body.redirect_uri;
    }

    let upstream;
    try {
      upstream = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': 'ops-widget-auth',
        },
        body: new URLSearchParams(form),
      });
    } catch {
      return fail(502, 'github_unreachable', cors);
    }

    /* Pass GitHub's response straight through. Deliberately not logged. */
    const payload = await upstream.text();
    return new Response(payload, { status: upstream.ok ? 200 : 502, headers: cors });
  },
};
