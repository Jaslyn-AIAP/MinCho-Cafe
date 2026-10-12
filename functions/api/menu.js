// =============================================================================
// POST /api/menu   body: { "code": "INVITE-CODE" }
// -----------------------------------------------------------------------------
// Returns the menu, prices and open dates — but only to people with the
// current invite code. Wrong code → 403 with no detail.
// =============================================================================
import { json, requireEnv, loadCatalogue } from '../../lib/server.js';
import { bottlePriceCents, isDateOpen, cutoffInstant, formatSgt, safeEqual } from '../../lib/rules.js';

export async function onRequestPost({ request, env }) {
  try {
    requireEnv(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'TURNSTILE_SITE_KEY']);

    const body = await request.json().catch(() => ({}));
    const code = String(body.code || '').trim().toUpperCase();
    if (!code || code.length > 64) return json({ error: 'Please enter the invite code.' }, 400);

    const { settings, products, sizes, dates } = await loadCatalogue(env);

    if (!safeEqual(code, settings.invite_code.trim().toUpperCase())) {
      return json({ error: 'That invite code is not valid. Please check with Master Ming or QQ.' }, 403);
    }

    const now = new Date();
    const openDates = dates
      .filter((d) => isDateOpen(d.delivery_date, settings, now))
      .map((d) => ({
        id: d.id,
        date: d.delivery_date,
        note: d.note,
        closes: formatSgt(cutoffInstant(d.delivery_date, settings.cutoff_days, settings.cutoff_time)),
      }));

    // A size is volume + container, e.g. { ml: 500, container: 'packet' }.
    // Prices depend on volume only, so bottlePrices below is keyed by ml.
    const activeSizes = sizes.filter((s) => s.active).map((s) => ({ ml: s.ml, container: s.container || 'bottle' }));
    const activeMl = [...new Set(activeSizes.map((s) => s.ml))];

    return json({
      shopName: settings.shop_name,
      orderingOpen: settings.ordering_open,
      deliveryEnabled: settings.delivery_enabled,
      deliveryFeeCents: settings.delivery_fee_cents,
      freeDeliveryMinCents: settings.free_delivery_min_cents || 0,
      minOrderCents: settings.min_order_cents,
      collectionNote: settings.collection_note,
      turnstileSiteKey: env.TURNSTILE_SITE_KEY,
      sizes: activeSizes,
      products: products
        .filter((p) => p.active)
        .map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          pricePerLitreCents: p.price_per_litre_cents,
          // Pre-computed so the browser shows exactly what the server will charge
          bottlePrices: Object.fromEntries(activeMl.map((ml) => [ml, bottlePriceCents(p.price_per_litre_cents, ml)])),
        })),
      dates: openDates,
    });
  } catch (err) {
    console.error(err);
    return json({ error: 'Something went wrong. Please try again later.' }, 500);
  }
}
