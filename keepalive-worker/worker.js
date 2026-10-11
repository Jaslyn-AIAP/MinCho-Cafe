// =============================================================================
// Keep-alive worker: pings the site's /api/health twice a week (Mon and Thu)
// -----------------------------------------------------------------------------
// Why: Supabase's free plan pauses a project after about 7 days of low activity
// ("a few requests each day" keeps it active). A paused project makes the order
// form and admin page stop working until someone resumes it by hand.
// /api/health does one tiny database read and returns {"ok":true}.
//
// Set up in the Cloudflare dashboard (see README "Keep the database awake"):
//   variable SITE_URL = https://mincho-cafe.pages.dev, cron "17 0 * * 1,4".
// A failed ping throws, so it shows as an error in the worker's logs.
// =============================================================================
export default {
  async scheduled(event, env, ctx) {
    const res = await fetch(`${env.SITE_URL}/api/health`, { headers: { 'user-agent': 'mincho-keepalive' } });
    const body = await res.text();
    console.log('keepalive', res.status, body);
    if (!res.ok) throw new Error(`Health check failed: ${res.status} ${body}`);
  },
};
