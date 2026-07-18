/**
 * ops-widget auth function — GitHub OAuth token exchange.
 *
 * WHY THIS EXISTS
 * GitHub supports neither PKCE nor CORS on its OAuth endpoints, so a browser
 * cannot complete a GitHub sign-in by itself: the final code->token swap must
 * be made by something holding the client secret. This function is that
 * something, and nothing more.
 *
 * WHAT IT DOES NOT DO
 *  - does not store tokens (no DB, no cache, no state of any kind)
 *  - does not log tokens, codes, or request bodies
 *  - is never called again after sign-in: all GitHub API traffic goes
 *    browser -> api.github.com directly
 *
 * The token exists here only as a local variable for the duration of one
 * request. This file is public so that claim is auditable.
 *
 * Routes:  POST /api/github/exchange   { code, redirect_uri }
 *          POST /api/github/refresh    { refresh_token }
 */

const { app } = require('@azure/functions');

/* Extra origins may be added via the ALLOWED_ORIGINS app setting (comma-separated). */
const BASE_ORIGINS = ['https://gbx-ai.github.io', 'http://localhost:8080'];

function allowedOrigins() {
  const extra = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return new Set([...BASE_ORIGINS, ...extra]);
}

function corsHeaders(origin) {
  if (!origin || !allowedOrigins().has(origin)) return null;
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const fail = (status, error, headers) => ({
  status,
  headers: headers || { 'Content-Type': 'application/json' },
  body: JSON.stringify({ error }),
});

app.http('githubAuth', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'github/{action}',
  handler: async (request, context) => {
    const origin = request.headers.get('origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return cors ? { status: 204, headers: cors } : fail(403, 'origin_not_allowed');
    }
    /* An unknown origin must never reach the secret. */
    if (!cors) return fail(403, 'origin_not_allowed');

    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;
    if (!clientId || !clientSecret) return fail(500, 'function_not_configured', cors);

    let body;
    try { body = await request.json(); }
    catch { return fail(400, 'invalid_json', cors); }

    const form = { client_id: clientId, client_secret: clientSecret };

    if (request.params.action === 'refresh') {
      if (!body.refresh_token) return fail(400, 'missing_refresh_token', cors);
      form.grant_type = 'refresh_token';
      form.refresh_token = body.refresh_token;
    } else {
      if (!body.code) return fail(400, 'missing_code', cors);
      form.code = body.code;
      if (body.redirect_uri) form.redirect_uri = body.redirect_uri;
    }

    let upstream, payload;
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
      payload = await upstream.text();
    } catch {
      /* deliberately logs no request detail */
      context.error('github token endpoint unreachable');
      return fail(502, 'github_unreachable', cors);
    }

    /* Pass GitHub's response straight through. Deliberately not logged. */
    return { status: upstream.ok ? 200 : 502, headers: cors, body: payload };
  },
});
