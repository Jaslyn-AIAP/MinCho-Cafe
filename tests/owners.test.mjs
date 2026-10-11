// Run: npm test
// Owner management and first-owner setup, with Supabase Auth and the database
// replaced by an in-memory fake (global fetch is stubbed).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as owners from '../functions/api/owners.js';
import * as setup from '../functions/api/setup.js';

const env = {
  SUPABASE_URL: 'https://fake.supabase.co',
  SUPABASE_SERVICE_KEY: 'sb_secret_test',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  SETUP_CODE: 'let-me-in-123',
};
const JAS = '11111111-1111-4111-8111-111111111111';
const QQ = '22222222-2222-4222-8222-222222222222';

let state;
beforeEach(() => {
  state = { users: new Map(), admins: [], tokens: new Map(), seen: [] };
  let n = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    state.seen.push({ u, method: init.method || 'GET', headers });
    const reply = (data, status = 200) => new Response(data === null ? null : JSON.stringify(data), { status });

    // Who is this token?
    if (u.endsWith('/auth/v1/user')) {
      const id = state.tokens.get(headers.authorization?.slice(7));
      return id ? reply({ id, email: state.users.get(id) }) : reply({ msg: 'bad jwt' }, 401);
    }
    // Admin: create / delete logins (must use the secret key)
    if (u.includes('/auth/v1/admin/users')) {
      assert.equal(headers.apikey, env.SUPABASE_SERVICE_KEY);
      if (init.method === 'POST') {
        const { email } = JSON.parse(init.body);
        if ([...state.users.values()].includes(email)) return reply({ msg: 'A user with this email address has already been registered' }, 422);
        const id = `33333333-3333-4333-8333-${String(++n).padStart(12, '0')}`;
        state.users.set(id, email);
        return reply({ id, email });
      }
      if (init.method === 'DELETE') {
        const id = u.split('/').pop();
        state.users.delete(id);
        state.admins = state.admins.filter((a) => a.user_id !== id); // on delete cascade
        return reply({});
      }
    }
    // Database (PostgREST)
    const path = decodeURIComponent(u.split('/rest/v1/')[1] || '');
    if (path.startsWith('admins')) {
      if (init.method === 'POST') { state.admins.push({ ...JSON.parse(init.body), created_at: new Date().toISOString() }); return reply(null, 201); }
      if (init.method === 'DELETE') { const id = path.match(/user_id=eq\.([\w-]+)/)[1]; state.admins = state.admins.filter((a) => a.user_id !== id); return reply(null, 204); }
      let rows = state.admins;
      const byId = path.match(/user_id=eq\.([\w-]+)/); if (byId) rows = rows.filter((a) => a.user_id === byId[1]);
      const byEmail = path.match(/email=eq\.([^&]+)/); if (byEmail) rows = rows.filter((a) => a.email === byEmail[1]);
      if (path.includes('limit=1')) rows = rows.slice(0, 1);
      return reply(rows);
    }
    throw new Error('Unexpected fetch ' + u);
  };
});

const call = (fn, { body, token, method = 'POST' } = {}) => fn({
  request: new Request('https://x/api', {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: body ? JSON.stringify(body) : undefined,
  }),
  env,
});
const loggedIn = (id, email) => { state.users.set(id, email); state.admins.push({ user_id: id, email, created_at: '2026-10-10' }); state.tokens.set('tok-' + email, id); return 'tok-' + email; };

test('setup creates the first owner only with the right code, and only once', async () => {
  assert.equal((await (await setup.onRequestGet({ env })).json()).needed, true);
  let r = await call(setup.onRequestPost, { body: { setupCode: 'wrong', email: 'jas@example.com', password: 'longpassword1' } });
  assert.equal(r.status, 403);
  r = await call(setup.onRequestPost, { body: { setupCode: env.SETUP_CODE, email: 'Jas@Example.com', password: 'longpassword1' } });
  assert.equal(r.status, 201);
  assert.equal(state.admins.length, 1);
  assert.equal(state.admins[0].email, 'jas@example.com');
  assert.equal((await (await setup.onRequestGet({ env })).json()).needed, false);
  r = await call(setup.onRequestPost, { body: { setupCode: env.SETUP_CODE, email: 'stranger@example.com', password: 'longpassword1' } });
  assert.equal(r.status, 403, 'second setup refused');
});

test('setup is off when SETUP_CODE is not set', async () => {
  const noCode = { ...env, SETUP_CODE: '' };
  assert.equal((await (await setup.onRequestGet({ env: noCode })).json()).needed, false);
  const r = await setup.onRequestPost({ request: new Request('https://x', { method: 'POST', body: JSON.stringify({ setupCode: '', email: 'a@b.co', password: 'longpassword1' }) }), env: noCode });
  assert.equal(r.status, 403);
});

test('only logged-in owners can list or add owners', async () => {
  assert.equal((await call(owners.onRequestGet, { method: 'GET' })).status, 401);
  state.users.set(QQ, 'stranger@example.com'); state.tokens.set('tok-stranger', QQ); // a login that is NOT an owner
  assert.equal((await call(owners.onRequestPost, { token: 'tok-stranger', body: { email: 'x@y.co', password: 'longpassword1' } })).status, 401);
  assert.equal(state.admins.length, 0);
});

test('owner adds two more owners; duplicates and weak passwords refused', async () => {
  const t = loggedIn(JAS, 'jas@example.com');
  assert.equal((await call(owners.onRequestPost, { token: t, body: { email: 'mingming@example.com', password: 'longpassword1' } })).status, 201);
  assert.equal((await call(owners.onRequestPost, { token: t, body: { email: 'qq@example.com', password: 'longpassword2' } })).status, 201);
  assert.equal((await call(owners.onRequestPost, { token: t, body: { email: 'qq@example.com', password: 'longpassword2' } })).status, 409);
  assert.equal((await call(owners.onRequestPost, { token: t, body: { email: 'new@example.com', password: 'short' } })).status, 400);
  assert.equal((await call(owners.onRequestPost, { token: t, body: { email: 'not-an-email', password: 'longpassword1' } })).status, 400);
  const list = await (await call(owners.onRequestGet, { token: t, method: 'GET' })).json();
  assert.deepEqual(list.owners.map((o) => o.email), ['jas@example.com', 'mingming@example.com', 'qq@example.com']);
  assert.equal(list.you, JAS);
  // admin calls used the secret key; the who-am-I call used the owner's token
  const who = state.seen.find((s) => s.u.endsWith('/auth/v1/user'));
  assert.equal(who.headers.authorization, `Bearer ${t}`);
});

test('remove: not yourself, not the last owner; removal deletes the login', async () => {
  const t = loggedIn(JAS, 'jas@example.com');
  assert.equal((await call(owners.onRequestDelete, { token: t, method: 'DELETE', body: { userId: JAS } })).status, 400);
  const qqToken = loggedIn(QQ, 'qq@example.com');
  // QQ removes Jas (e.g. at handover)
  const r = await call(owners.onRequestDelete, { token: qqToken, method: 'DELETE', body: { userId: JAS } });
  assert.equal(r.status, 200);
  assert.equal(state.users.has(JAS), false);
  assert.deepEqual(state.admins.map((a) => a.email), ['qq@example.com']);
  // Jas's old token no longer works
  assert.equal((await call(owners.onRequestGet, { token: t, method: 'GET' })).status, 401);
});

test('a new owner is saved with the display name shown on orders; over-long names refused', async () => {
  const t = loggedIn(JAS, 'jas@example.com');
  assert.equal((await call(owners.onRequestPost, { token: t, body: { name: '  QQ ', email: 'qq@example.com', password: 'longpassword2' } })).status, 201);
  assert.equal(state.admins.find((a) => a.email === 'qq@example.com').display_name, 'QQ');
  assert.equal((await call(owners.onRequestPost, { token: t, body: { name: 'x'.repeat(31), email: 'long@example.com', password: 'longpassword2' } })).status, 400);
  // Without a name (e.g. the first-owner setup) the row has no display_name; the page falls back to the email
  assert.equal((await call(owners.onRequestPost, { token: t, body: { email: 'ming@example.com', password: 'longpassword3' } })).status, 201);
  assert.equal('display_name' in state.admins.find((a) => a.email === 'ming@example.com'), false);
});
