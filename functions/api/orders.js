// =============================================================================
// POST /api/orders — place an order
// -----------------------------------------------------------------------------
// The browser sends WHAT the customer wants. The server decides whether it is
// allowed and HOW MUCH it costs. Nothing price-related from the browser is
// trusted.
//
// Checks, in order (cheapest first, so bots are rejected early):
//   1. Request size and JSON shape
//   2. Cloudflare Turnstile (bot check)
//   3. Ordering switched on + invite code matches
//   4. Delivery date exists, is active, and before its cutoff
//   5. Customer details (name, Singapore phone, delivery/address rules, consent)
//   6. Items → priced from the database; minimum order; delivery fee
//   7. Rate limit: max 5 orders per hour from the same network
// =============================================================================
import { json, requireEnv, loadCatalogue, db, verifyTurnstile, hashIp, notifyOwners } from '../../lib/server.js';
import { priceItems, itemSize, deliveryFeeCents as feeFor, isDateOpen, normalisePhone, makeOrderRef, money, safeEqual } from '../../lib/rules.js';

const MAX_BODY_BYTES = 10_000;
const MAX_ORDERS_PER_HOUR_PER_IP = 5;

export async function onRequestPost({ request, env }) {
  try {
    requireEnv(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'TURNSTILE_SECRET_KEY', 'IP_HASH_SALT']);

    // ---- 1. Parse body safely --------------------------------------------
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: 'Request too large.' }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: 'Invalid request.' }, 400); }
    if (!body || typeof body !== 'object') return json({ error: 'Invalid request.' }, 400);

    // ---- 2. Bot check ---------------------------------------------------------
    // CF-Connecting-IP is set by Cloudflare to the real visitor IP.
    const ip = request.headers.get('CF-Connecting-IP') || '';
    if (!(await verifyTurnstile(env, body.turnstileToken, ip))) {
      return json({ error: 'Security check failed. Please refresh the page and try again.' }, 403);
    }

    // ---- 3. Ordering open + invite code -----------------------------------
    const { settings, products, sizes, dates } = await loadCatalogue(env);
    if (!settings.ordering_open) return json({ error: 'Ordering is paused right now.' }, 403);
    const code = String(body.code || '').trim().toUpperCase();
    if (!safeEqual(code, settings.invite_code.trim().toUpperCase())) {
      return json({ error: 'That invite code is no longer valid.' }, 403);
    }

    // ---- 4. Date -------------------------------------------------------------
    const date = dates.find((d) => d.id === body.dateId); // `dates` only contains active dates
    if (!date) return json({ error: 'Please choose a delivery date.' }, 400);
    if (!isDateOpen(date.delivery_date, settings)) {
      return json({ error: 'Sorry, orders for that date have closed.' }, 409);
    }

    // ---- 5. Customer details --------------------------------------------------
    const name = String(body.name || '').trim().replace(/\s+/g, ' ');
    if (name.length < 1 || name.length > 80) return json({ error: 'Please enter your name (max 80 characters).' }, 400);

    const phone = normalisePhone(String(body.phone || ''));
    if (!phone) return json({ error: 'Please enter a Singapore mobile number (8 digits, starting with 8 or 9).' }, 400);

    const fulfilment = body.fulfilment === 'delivery' ? 'delivery' : 'collection';
    let address = null;
    if (fulfilment === 'delivery') {
      if (!settings.delivery_enabled) return json({ error: 'Delivery is not available right now.' }, 400);
      address = String(body.address || '').trim();
      if (address.length < 5 || address.length > 300) return json({ error: 'Please enter your delivery address.' }, 400);
    }

    const notes = String(body.notes || '').trim().slice(0, 500);
    if (body.consent !== true) return json({ error: 'Please agree to the personal data notice.' }, 400);

    // ---- 6. Items and money ---------------------------------------------------
    const priced = priceItems(body.items, products, sizes);
    if (!priced.ok) return json({ error: priced.error }, 400);
    if (priced.subtotalCents < settings.min_order_cents) {
      return json({ error: `Minimum order is ${money(settings.min_order_cents)}.` }, 400);
    }
    const deliveryFeeCents = feeFor(fulfilment, priced.subtotalCents, settings);
    const totalCents = priced.subtotalCents + deliveryFeeCents;

    // ---- 7. Rate limit --------------------------------------------------------
    const ipHash = await hashIp(ip, env.IP_HASH_SALT);
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const recent = await db(env, `orders?select=id&ip_hash=eq.${ipHash}&created_at=gte.${encodeURIComponent(since)}&limit=${MAX_ORDERS_PER_HOUR_PER_IP}`);
    if (recent.length >= MAX_ORDERS_PER_HOUR_PER_IP) {
      return json({ error: 'Too many orders from this network. Please try again later or message the owners.' }, 429);
    }

    // ---- Save (retry if the random order reference happens to clash) --------
    let saved = null;
    for (let attempt = 0; attempt < 3 && !saved; attempt++) {
      const orderRef = makeOrderRef(date.delivery_date, crypto.getRandomValues(new Uint8Array(4)));
      try {
        const rows = await db(env, 'orders', {
          method: 'POST',
          headers: { prefer: 'return=representation' },
          body: JSON.stringify({
            order_ref: orderRef,
            delivery_date_id: date.id,
            customer_name: name,
            phone,
            fulfilment,
            address,
            notes,
            items: priced.items,
            subtotal_cents: priced.subtotalCents,
            delivery_fee_cents: deliveryFeeCents,
            total_cents: totalCents,
            pdpa_consent: true,
            ip_hash: ipHash,
          }),
        });
        saved = rows[0];
      } catch (err) {
        if (err.status !== 409) throw err; // 409 = unique violation on order_ref → retry
      }
    }
    if (!saved) throw new Error('Could not generate a unique order reference');

    // ---- Notify owners (never blocks or fails the order) ----------------------
    const lines = priced.items.map((i) => `• ${i.product_name} ${itemSize(i.size_ml, i.container)} × ${i.qty}`);
    await notifyOwners(env, [
      `🧋 New order ${saved.order_ref} — ${money(totalCents)}`,
      `${name} (${phone}) · ${date.delivery_date} · ${fulfilment}`,
      ...lines,
      notes ? `Notes: ${notes}` : '',
    ].filter(Boolean).join('\n'));

    // ---- Reply to customer ------------------------------------------------------
    return json({
      orderRef: saved.order_ref,
      date: date.delivery_date,
      fulfilment,
      items: priced.items,
      subtotalCents: priced.subtotalCents,
      deliveryFeeCents,
      totalCents,
      paynowNumber: settings.paynow_number,
      collectionNote: fulfilment === 'collection' ? settings.collection_note : '',
    }, 201);
  } catch (err) {
    console.error(err);
    return json({ error: 'Something went wrong saving your order. Please try again, or message the owners.' }, 500);
  }
}
