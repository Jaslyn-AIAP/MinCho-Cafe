// =============================================================================
// lib/server.js — helpers used only by the Cloudflare server functions
// -----------------------------------------------------------------------------
// No npm packages: everything uses the built-in `fetch` and Web Crypto API,
// so there is no build step and nothing to keep patched.
//
// Environment variables (Cloudflare Pages → Settings → Variables and Secrets):
//   SUPABASE_URL              e.g. https://abcd1234.supabase.co
//   SUPABASE_SERVICE_KEY      SECRET. Service-role / secret key. Never in the browser.
//   SUPABASE_PUBLISHABLE_KEY  Public anon / publishable key (used by admin page login)
//   TURNSTILE_SITE_KEY        public
//   TURNSTILE_SECRET_KEY      SECRET
//   IP_HASH_SALT              SECRET. Any long random string.
//   TELEGRAM_BOT_TOKEN        SECRET, optional
//   TELEGRAM_CHAT_ID          optional (the owners' group chat id)
//   RESEND_API_KEY            SECRET, optional (email notification)
//   NOTIFY_EMAIL              optional (must be the Resend account's own email
//                             unless you verify a domain with Resend)
// =============================================================================

/** JSON response with no caching (orders and settings must always be fresh). */
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Fail fast with a clear message if a required secret is missing. */
export function requireEnv(env, names) {
  const missing = names.filter((n) => !env[n]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
}

/**
 * Call Supabase's REST API (PostgREST) with the service-role key.
 * The service role bypasses Row Level Security, which is why this key lives
 * only on the server.
 *
 * @param {object} env  Cloudflare env bindings
 * @param {string} path e.g. 'products?select=*&order=sort_order'
 * @param {RequestInit} init
 */
export async function db(env, path, init = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      // New-style secret keys (sb_secret_…) go in `apikey` only — they are not
      // JWTs. Legacy service_role keys (eyJ…) also need the Bearer header.
      // https://supabase.com/docs/guides/api/api-keys
      apikey: env.SUPABASE_SERVICE_KEY,
      ...(env.SUPABASE_SERVICE_KEY.startsWith('eyJ') ? { authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` } : {}),
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    // Log details server-side only; the customer gets a generic message.
    console.error('Supabase error', res.status, path, text);
    const err = new Error('Database request failed');
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

/** Load everything the order form needs in parallel. */
export async function loadCatalogue(env) {
  const [settingsRows, products, sizes, dates] = await Promise.all([
    db(env, 'settings?id=eq.1&select=*'),
    db(env, 'products?select=*&order=sort_order'),
    db(env, 'bottle_sizes?select=*&order=ml'),
    db(env, 'delivery_dates?select=*&active=eq.true&order=delivery_date'),
  ]);
  if (!settingsRows?.length) throw new Error('Settings row missing — did schema.sql run?');
  return { settings: settingsRows[0], products, sizes, dates };
}

/**
 * Verify a Cloudflare Turnstile token with Cloudflare's siteverify endpoint.
 * Docs: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */
export async function verifyTurnstile(env, token, ip) {
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET_KEY);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  if (!res.ok) return false;
  const outcome = await res.json();
  return outcome.success === true;
}

/**
 * Salted SHA-256 of the visitor's IP address. Used only for rate limiting, so
 * the raw IP (personal data) is never stored.
 */
export async function hashIp(ip, salt) {
  const data = new TextEncoder().encode(`${salt}:${ip || 'unknown'}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Send new-order notifications. Each channel is optional and independent:
 * a failure in one never fails the order (the order is already saved and the
 * admin page always shows it).
 */
export async function notifyOwners(env, text) {
  const tasks = [];

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    tasks.push(
      fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
      }),
    );
  }

  if (env.RESEND_API_KEY && env.NOTIFY_EMAIL) {
    tasks.push(
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: 'MinCho Cafe <onboarding@resend.dev>',
          to: [env.NOTIFY_EMAIL],
          subject: text.split('\n')[0],
          text,
        }),
      }),
    );
  }

  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === 'rejected') console.error('Notification failed', r.reason);
    else if (!r.value.ok) console.error('Notification failed', r.value.status, await r.value.text());
  }
}

// =============================================================================
// Owner accounts (Supabase Auth). Headers mirror what the official
// supabase-js v2 library sends: the key as `apikey` and as a Bearer token for
// admin calls; the owner's own access token as Bearer when checking who they are.
// =============================================================================
const AUTH_VERSION = { 'X-Supabase-Api-Version': '2024-01-01' };

/** Call a Supabase Auth admin endpoint (create/delete logins). Server only. */
export async function authAdmin(env, path, init = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'content-type': 'application/json',
      ...AUTH_VERSION,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) console.error('Supabase Auth error', res.status, path, text);
  return { ok: res.ok, status: res.status, body };
}

/**
 * Who is making this request? Reads the owner's access token from the
 * Authorization header, asks Supabase Auth who it belongs to, then checks the
 * `admins` table. Returns { id, email } for an owner, otherwise null.
 */
export async function requireOwner(request, env) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || token.length > 4096) return null;
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, authorization: `Bearer ${token}`, ...AUTH_VERSION },
  });
  if (!res.ok) return null;
  const user = await res.json();
  if (!user?.id) return null;
  const rows = await db(env, `admins?select=user_id,email&user_id=eq.${encodeURIComponent(user.id)}`);
  return rows.length ? { id: user.id, email: rows[0].email } : null;
}

/** Basic email check (Supabase does its own as well). */
export function validEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Create a login and record it as an owner. If the owner row can't be saved,
 * the new login is deleted again so nothing is left half-made.
 * Returns { ok: true, owner } or { ok: false, status, error }.
 */
export async function createOwner(env, email, password) {
  const created = await authAdmin(env, 'admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!created.ok) {
    const msg = String(created.body?.msg || created.body?.message || created.body?.error_description || '');
    if (created.status === 422 && /already|exists|registered/i.test(msg)) {
      return { ok: false, status: 409, error: 'That email already has a login. Remove it in Supabase first, or use another email.' };
    }
    if (created.status === 422 && /password/i.test(msg)) {
      return { ok: false, status: 400, error: `Supabase rejected the password: ${msg}` };
    }
    return { ok: false, status: 502, error: 'Could not create the login. Please try again.' };
  }
  const user = created.body?.user || created.body; // response shape: the user object
  try {
    await db(env, 'admins', { method: 'POST', body: JSON.stringify({ user_id: user.id, email }) });
  } catch (err) {
    await authAdmin(env, `admin/users/${user.id}`, { method: 'DELETE' });
    throw err;
  }
  return { ok: true, owner: { user_id: user.id, email } };
}
