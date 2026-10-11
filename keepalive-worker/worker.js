// =============================================================================
// Keep-alive worker: pings the site's /api/health twice a week (Mon and Thu)
// -----------------------------------------------------------------------------
// Why: Supabase's free plan pauses a project after about 7 days of low activity.
// A paused project keeps its data, but the order form and admin page stop
// working until someone clicks "Resume project" in Supabase.
// /api/health does one tiny database read and returns {"ok":true}.
//
// Set up in the Cloudflare dashboard (see README "Keep the database awake"):
//   variable SITE_URL = https://mincho-cafe.pages.dev (Text, Production)
//   cron trigger "17 0 * * MON,THU" = Monday and Thursday 08:17 Singapore time
// Opening the worker's own address runs the same check by hand and shows the
// result, e.g. "Result: 200 {"ok":true}". A failed scheduled ping throws, so it
// shows as an error in the worker's logs.
// =============================================================================

// Checks the shop's /api/health once and reports the result.
async function ping(env) {
  const res = await fetch(`${env.SITE_URL}/api/health`, { headers: { 'user-agent': 'mincho-keepalive' } });
  const body = await res.text();
  console.log('keepalive', res.status, body);
  return { ok: res.ok, status: res.status, body };
}

export default {
  // Runs on the schedule (Monday and Thursday): this is what keeps Supabase awake
  async scheduled(event, env, ctx) {
    const r = await ping(env);
    if (!r.ok) throw new Error(`Health check failed: ${r.status} ${r.body}`);
  },

  // Runs when someone opens the worker's address: a manual test of the same check
  async fetch(request, env, ctx) {
    if (!env.SITE_URL) {
      return new Response('Keep-alive worker: SITE_URL is not set yet (Settings → Variables and Secrets).', { status: 500 });
    }
    try {
      const r = await ping(env);
      const time = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19) + '+08:00';
      return new Response(
        `Keep-alive worker\nChecked: ${env.SITE_URL}/api/health\nResult: ${r.status} ${r.body}\nTime: ${time}\nSchedule: Monday and Thursday, 08:17 Singapore time`,
        { status: r.ok ? 200 : 502, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    } catch (err) {
      return new Response(`Keep-alive worker: could not reach the site. ${err.message}`, { status: 502 });
    }
  },
};
