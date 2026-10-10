// =============================================================================
// GET /api/admin-config
// -----------------------------------------------------------------------------
// Gives the admin page the Supabase project URL and the PUBLISHABLE (anon) key.
// These two values are designed to be public: on their own they grant nothing,
// because every table is protected by Row Level Security and only users listed
// in `admins` can read or change data. Serving them from here (instead of
// hard-coding them in admin.js) means no keys live in the code repository.
// =============================================================================
import { json, requireEnv } from '../../lib/server.js';

export async function onRequestGet({ env }) {
  try {
    requireEnv(env, ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY']);
    return json({ supabaseUrl: env.SUPABASE_URL, supabaseKey: env.SUPABASE_PUBLISHABLE_KEY });
  } catch (err) {
    console.error(err);
    return json({ error: 'Admin page is not configured yet.' }, 500);
  }
}
