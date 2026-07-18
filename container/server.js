/**
 * ops-widget auth service — GitHub OAuth token exchange.
 *
 * WHY THIS EXISTS
 * GitHub supports neither PKCE nor CORS on its OAuth endpoints, so a browser
 * cannot complete a GitHub sign-in by itself: the final code->token swap must
 * be made by something holding the client secret. This service is that
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
 * Zero npm dependencies on purpose — the smaller this is, the easier it is
 * to read it and believe the paragraph above.
 *
 * Routes:  POST /github/exchange  { code, redirect_uri }
 *          POST /github/refresh   { refresh_token }
 *          GET  /health
 */

const http = require('node:http');

const PORT = process.env.PORT || 8080;
const BASE_ORIGINS = ['https://gbx-ai.github.io', 'http://localhost:8080'];

const allowed = new Set([
  ...BASE_ORIGINS,
  ...(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
]);

function corsFor(origin) {
  if (!origin || !allowed.has(origin)) return null;
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const send = (res, status, headers, body) => {
  res.writeHead(status, headers || { 'Content-Type': 'application/json' });
  res.end(body ?? '');
};
const fail = (res, status, error, headers) =>
  send(res, status, headers, JSON.stringify({ error }));

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > limit) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { 'Content-Type': 'application/json' },
      JSON.stringify({ ok: true, configured: !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) }));
  }

  const cors = corsFor(req.headers.origin);

  if (req.method === 'OPTIONS') {
    return cors ? send(res, 204, cors) : fail(res, 403, 'origin_not_allowed');
  }
  /* An unknown origin must never reach the secret. */
  if (!cors) return fail(res, 403, 'origin_not_allowed');
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', cors);

  const isRefresh = url.pathname.endsWith('/refresh');
  if (!isRefresh && !url.pathname.endsWith('/exchange')) return fail(res, 404, 'not_found', cors);

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return fail(res, 500, 'service_not_configured', cors);

  let body;
  try { body = JSON.parse(await readBody(req) || '{}'); }
  catch { return fail(res, 400, 'invalid_json', cors); }

  const form = { client_id: clientId, client_secret: clientSecret };
  if (isRefresh) {
    if (!body.refresh_token) return fail(res, 400, 'missing_refresh_token', cors);
    form.grant_type = 'refresh_token';
    form.refresh_token = body.refresh_token;
  } else {
    if (!body.code) return fail(res, 400, 'missing_code', cors);
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
    console.error('github token endpoint unreachable');
    return fail(res, 502, 'github_unreachable', cors);
  }

  /* Pass GitHub's response straight through. Deliberately not logged. */
  send(res, upstream.ok ? 200 : 502, cors, payload);
});

server.listen(PORT, () => console.log(`ops-widget-auth listening on ${PORT}`));
