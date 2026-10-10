// =============================================================================
// GET /api/health
// -----------------------------------------------------------------------------
// Tiny database read used by the keep-alive worker (see keepalive-worker/).
// Supabase's free plan pauses a project after about a week with no activity;
// a daily ping keeps it awake between weekly order rounds.
// Returns no data — just ok/error.
// =============================================================================
import { json, db } from '../../lib/server.js';

export async function onRequestGet({ env }) {
  try {
    await db(env, 'settings?id=eq.1&select=id');
    return json({ ok: true });
  } catch (err) {
    console.error(err);
    return json({ ok: false }, 503);
  }
}
