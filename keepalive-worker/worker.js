// =============================================================================
// Keep-alive worker — pings the site's /api/health once a day
// -----------------------------------------------------------------------------
// Why: Supabase's free plan pauses projects after ~7 days of inactivity.
// Orders are weekly, so a quiet week could pause the database and break the
// order form. A daily read keeps it active.
//
// Deploy: see README → "Keep the database awake". The schedule lives in
// wrangler.toml ([triggers] crons). SITE_URL is set in wrangler.toml [vars].
// =============================================================================
export default {
  async scheduled(event, env, ctx) {
    const res = await fetch(`${env.SITE_URL}/api/health`, { headers: { 'user-agent': 'mincho-keepalive' } });
    // Shows up in Cloudflare → Workers → mincho-keepalive → Logs
    console.log('keepalive', res.status, await res.text());
  },
};
