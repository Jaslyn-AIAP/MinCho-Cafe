// =============================================================================
// /api/setup — create the FIRST owner (one time only)
// -----------------------------------------------------------------------------
// Works only while (a) there are no owners yet and (b) the Cloudflare secret
// SETUP_CODE is set. The person setting up must type that code, so a stranger
// who finds the admin page first cannot claim the shop.
// Once the first owner exists this endpoint refuses everything; you can then
// delete SETUP_CODE from Cloudflare for tidiness.
//
//   GET   → { needed: true|false }
//   POST  { setupCode, email, password } → creates the first owner
// =============================================================================
import { json, requireEnv, db, validEmail, createOwner } from '../../lib/server.js';
import { safeEqual } from '../../lib/rules.js';

async function noOwnersYet(env) {
  const rows = await db(env, 'admins?select=user_id&limit=1');
  return rows.length === 0;
}

export async function onRequestGet({ env }) {
  try {
    requireEnv(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY']);
    return json({ needed: Boolean(env.SETUP_CODE) && (await noOwnersYet(env)) });
  } catch (err) {
    console.error(err);
    return json({ needed: false });
  }
}

export async function onRequestPost({ request, env }) {
  try {
    requireEnv(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY']);
    if (!env.SETUP_CODE || !(await noOwnersYet(env))) return json({ error: 'Setup is already done. Log in instead.' }, 403);

    const body = await request.json().catch(() => ({}));
    if (!safeEqual(String(body.setupCode || ''), env.SETUP_CODE)) {
      return json({ error: 'That setup code is not correct.' }, 403);
    }
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!validEmail(email)) return json({ error: 'Please enter a valid email address.' }, 400);
    if (password.length < 10 || password.length > 72) return json({ error: 'Password must be 10 to 72 characters.' }, 400);

    const result = await createOwner(env, email, password);
    if (!result.ok) return json({ error: result.error }, result.status);
    console.log(`First owner ${email} created via setup`);
    return json({ owner: result.owner }, 201);
  } catch (err) {
    console.error(err);
    return json({ error: 'Setup failed. Please try again.' }, 500);
  }
}
