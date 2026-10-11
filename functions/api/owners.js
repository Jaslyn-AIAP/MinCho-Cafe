// =============================================================================
// /api/owners — list, add and remove shop owners (admin page → Settings)
// -----------------------------------------------------------------------------
// Only a logged-in owner can call this. Creating and deleting logins needs the
// secret key, which is why this runs on the server and not in the browser.
//
//   GET     → { owners: [{ user_id, email, created_at }], you: <your user_id> }
//   POST    { email, password }  → adds an owner with a starting password
//   DELETE  { userId }           → removes an owner and deletes their login
//
// Guards: you cannot remove yourself, and the last owner cannot be removed,
// so the shop can never be left with nobody able to log in.
// =============================================================================
import { json, requireEnv, db, authAdmin, requireOwner, validEmail, createOwner } from '../../lib/server.js';

const NEEDED = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_PUBLISHABLE_KEY'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function guard(request, env) {
  requireEnv(env, NEEDED);
  return requireOwner(request, env);
}

export async function onRequestGet({ request, env }) {
  try {
    const me = await guard(request, env);
    if (!me) return json({ error: 'Please log in again.' }, 401);
    // select=* so the list also shows can_confirm_payments (added by migration 005) once it exists
    const owners = await db(env, 'admins?select=*&order=created_at');
    return json({ owners, you: me.id });
  } catch (err) {
    console.error(err);
    return json({ error: 'Could not load owners.' }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const me = await guard(request, env);
    if (!me) return json({ error: 'Please log in again.' }, 401);
    const body = await request.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const name = String(body.name || '').trim().replace(/\s+/g, ' ');
    if (name.length > 30) return json({ error: 'Name must be 30 characters or fewer.' }, 400);
    if (!validEmail(email)) return json({ error: 'Please enter a valid email address.' }, 400);
    if (password.length < 10 || password.length > 72) return json({ error: 'Starting password must be 10 to 72 characters.' }, 400);

    const existing = await db(env, `admins?select=user_id&email=eq.${encodeURIComponent(email)}`);
    if (existing.length) return json({ error: 'That email is already an owner.' }, 409);

    const result = await createOwner(env, email, password, name);
    if (!result.ok) return json({ error: result.error }, result.status);
    console.log(`Owner ${email} added by ${me.email}`);
    return json({ owner: result.owner }, 201);
  } catch (err) {
    console.error(err);
    return json({ error: 'Could not add the owner. Please try again.' }, 500);
  }
}

export async function onRequestDelete({ request, env }) {
  try {
    const me = await guard(request, env);
    if (!me) return json({ error: 'Please log in again.' }, 401);
    const body = await request.json().catch(() => ({}));
    const userId = String(body.userId || '');
    if (!UUID.test(userId)) return json({ error: 'Unknown owner.' }, 400);
    if (userId === me.id) return json({ error: 'You cannot remove yourself. Ask another owner to do it.' }, 400);

    const owners = await db(env, 'admins?select=user_id,email');
    const target = owners.find((o) => o.user_id === userId);
    if (!target) return json({ error: 'That person is not an owner.' }, 404);
    if (owners.length <= 1) return json({ error: 'The shop must keep at least one owner.' }, 400);

    // Deleting the login also removes the owners row (on delete cascade).
    const del = await authAdmin(env, `admin/users/${userId}`, { method: 'DELETE' });
    if (!del.ok && del.status !== 404) return json({ error: 'Could not remove the owner. Please try again.' }, 502);
    // Belt and braces, in case the login was already gone:
    await db(env, `admins?user_id=eq.${userId}`, { method: 'DELETE' });
    console.log(`Owner ${target.email} removed by ${me.email}`);
    return json({ removed: userId });
  } catch (err) {
    console.error(err);
    return json({ error: 'Could not remove the owner. Please try again.' }, 500);
  }
}
