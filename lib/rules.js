// =============================================================================
// lib/rules.js — pure business rules (no network, no database)
// -----------------------------------------------------------------------------
// Kept separate so they can be unit-tested (see tests/rules.test.mjs) and so
// the browser can never be the source of truth: the browser shows an estimate,
// but the server recalculates everything with these functions.
// =============================================================================

// Singapore has no daylight saving, so UTC+8 all year round.
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Limits that stop silly or abusive orders. */
export const LIMITS = {
  maxQtyPerLine: 50,       // max bottles of one product/size in an order
  maxLines: 20,            // max distinct product/size lines
  maxLitresPerOrder: 60,   // sanity cap across the whole order
};

/**
 * Price of one bottle, in cents, from a per-litre price.
 * Example: 1800 cents/litre × 250 ml → 450 cents ($4.50).
 * Math.round handles any odd future sizes (e.g. 330 ml) to the nearest cent.
 */
export function bottlePriceCents(pricePerLitreCents, ml) {
  return Math.round((pricePerLitreCents * ml) / 1000);
}

/**
 * Validate the customer's item list and price it using the database's prices.
 *
 * A size is identified by volume AND container (e.g. 500 ml packet and
 * 500 ml bottle are different sizes). Price depends on volume only.
 *
 * @param {Array<{product_id:string,size_ml:number,container?:string,qty:number}>} rawItems
 *        Untrusted input from the browser.
 * @param {Array<{id:string,name:string,price_per_litre_cents:number,active:boolean}>} products
 * @param {Array<{ml:number,container:string,active:boolean}>} sizes
 * @returns {{ok:true, items:Array, subtotalCents:number, totalMl:number} | {ok:false, error:string}}
 *
 * Edge cases handled: duplicates are merged, qty 0 lines are dropped,
 * non-integers / negatives / unknown products / inactive sizes are rejected.
 * An item without a container (a page loaded before this change) is accepted
 * only if exactly one active size has that volume; otherwise it is ambiguous.
 */
export function priceItems(rawItems, products, sizes) {
  if (!Array.isArray(rawItems)) return { ok: false, error: 'Items must be a list.' };
  if (rawItems.length > LIMITS.maxLines * 2) return { ok: false, error: 'Too many items.' };

  const productById = new Map(products.filter((p) => p.active).map((p) => [p.id, p]));
  const active = sizes.filter((s) => s.active).map((s) => ({ ml: s.ml, container: s.container || 'bottle' }));
  const activeKeys = new Set(active.map((s) => `${s.ml}|${s.container}`));

  // Merge duplicate lines (same product + size) so totals cannot be gamed.
  const merged = new Map();
  for (const item of rawItems) {
    if (!item || typeof item !== 'object') return { ok: false, error: 'Invalid item.' };
    const { product_id: productId, size_ml: sizeMl, qty } = item;
    if (!productById.has(productId)) return { ok: false, error: 'Unknown product.' };
    if (!Number.isInteger(sizeMl)) return { ok: false, error: 'Unknown size.' };
    let container = item.container;
    if (container === undefined) {
      const matches = active.filter((s) => s.ml === sizeMl);
      if (matches.length !== 1) return { ok: false, error: 'Unknown size. Please refresh the page and try again.' };
      container = matches[0].container;
    }
    if (!activeKeys.has(`${sizeMl}|${container}`)) return { ok: false, error: 'Unknown size.' };
    if (!Number.isInteger(qty) || qty < 0) return { ok: false, error: 'Quantity must be a whole number.' };
    if (qty === 0) continue;
    const key = `${productId}|${sizeMl}|${container}`;
    merged.set(key, (merged.get(key) || 0) + qty);
  }

  if (merged.size === 0) return { ok: false, error: 'Please choose at least one item.' };
  if (merged.size > LIMITS.maxLines) return { ok: false, error: 'Too many different items.' };

  const items = [];
  let subtotalCents = 0;
  let totalMl = 0;
  for (const [key, qty] of merged) {
    if (qty > LIMITS.maxQtyPerLine) {
      return { ok: false, error: `Maximum ${LIMITS.maxQtyPerLine} of each item. Message the owners for bigger orders.` };
    }
    const [productId, sizeStr, container] = key.split('|');
    const sizeMl = Number(sizeStr);
    const product = productById.get(productId);
    const unitCents = bottlePriceCents(product.price_per_litre_cents, sizeMl);
    const lineCents = unitCents * qty;
    items.push({
      product_id: productId,
      product_name: product.name,
      size_ml: sizeMl,
      container,
      qty,
      unit_price_cents: unitCents,
      line_total_cents: lineCents,
    });
    subtotalCents += lineCents;
    totalMl += sizeMl * qty;
  }

  if (totalMl > LIMITS.maxLitresPerOrder * 1000) {
    return { ok: false, error: `Maximum ${LIMITS.maxLitresPerOrder} litres per order. Message the owners for bigger orders.` };
  }

  // Stable order for display: by product sort, then volume, then container.
  const sortIndex = new Map(products.map((p, i) => [p.id, p.sort_order ?? i]));
  items.sort((a, b) => sortIndex.get(a.product_id) - sortIndex.get(b.product_id)
    || a.size_ml - b.size_ml || a.container.localeCompare(b.container));

  return { ok: true, items, subtotalCents, totalMl };
}

/**
 * When does ordering close for a given delivery date?
 * Rule: closes at `cutoffTime` (Singapore time) `cutoffDays` days before.
 * Default settings (1 day, 23:59) → orders for 17 Oct close at 16 Oct 23:59 SGT.
 *
 * @param {string} deliveryDate 'YYYY-MM-DD'
 * @param {number} cutoffDays
 * @param {string} cutoffTime 'HH:MM' or 'HH:MM:SS' (Postgres `time` format)
 * @returns {Date} the cutoff instant (absolute time)
 */
export function cutoffInstant(deliveryDate, cutoffDays, cutoffTime) {
  const [y, m, d] = deliveryDate.split('-').map(Number);
  const [hh, mm, ss = 0] = String(cutoffTime).split(':').map(Number);
  // Build the wall-clock time in SGT as if it were UTC, then shift by 8 hours.
  const wallClockAsUtc = Date.UTC(y, m - 1, d - cutoffDays, hh, mm, ss);
  return new Date(wallClockAsUtc - SGT_OFFSET_MS);
}

/** Is this date still open for orders at time `now`? */
export function isDateOpen(deliveryDate, settings, now = new Date()) {
  return now.getTime() <= cutoffInstant(deliveryDate, settings.cutoff_days, settings.cutoff_time).getTime();
}

/** Format a cutoff as e.g. "Fri 16 Oct, 11:59 pm" in Singapore time. */
export function formatSgt(date) {
  return new Intl.DateTimeFormat('en-SG', {
    timeZone: 'Asia/Singapore',
    weekday: 'short', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(date);
}

/**
 * Delivery fee for an order, in cents.
 * - Collection orders: always 0.
 * - Delivery: free when the drinks subtotal reaches `free_delivery_min_cents`
 *   (that amount AND above counts as free); otherwise `delivery_fee_cents`.
 * - free_delivery_min_cents = 0 means delivery is never free.
 * The threshold uses the drinks subtotal, not subtotal + fee, so the fee
 * can never push an order over the line.
 */
export function deliveryFeeCents(fulfilment, subtotalCents, settings) {
  if (fulfilment !== 'delivery') return 0;
  const freeFrom = settings.free_delivery_min_cents || 0;
  if (freeFrom > 0 && subtotalCents >= freeFrom) return 0;
  return settings.delivery_fee_cents || 0;
}

/** 250 → "250 ml", 1000 → "1 L" */
export function sizeLabel(ml) {
  return ml >= 1000 ? `${ml / 1000} L` : `${ml} ml`;
}

/** "250 ml packet", "1 L bottle" */
export function itemSize(ml, container) {
  return `${sizeLabel(ml)} ${container || 'bottle'}`;
}

/** Cents → "$4.50" */
export function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Normalise a Singapore MOBILE number (8xxx or 9xxx): strips spaces, dashes and a +65 prefix.
 * Returns the 8-digit string, or null if it is not a valid local mobile number (landlines 6xxx and virtual numbers 3xxx are rejected).
 */
export function normalisePhone(raw) {
  if (typeof raw !== 'string') return null;
  let digits = raw.replace(/[\s\-()]/g, '');
  if (digits.startsWith('+65')) digits = digits.slice(3);
  else if (digits.startsWith('65') && digits.length === 10) digits = digits.slice(2);
  return /^[89]\d{7}$/.test(digits) ? digits : null;
}

/**
 * Human-friendly order reference: MC + MMDD of the delivery date + 4 random
 * LETTERS, e.g. MC1017KQXV.
 * - Letters and digits only: some bank apps refuse dashes or spaces in the
 *   PayNow message ("No emojis or special characters allowed").
 * - The random part is letters only, so the date digits and the code stay easy
 *   to tell apart without a dash.
 * - No look-alike letters (I, L, O), so it is easy to read out or type.
 * 23^4 ≈ 280,000 codes per date; the server retries on the rare clash.
 * (Orders before 11 Oct 2026 have the older form MC1017-2CU5.)
 */
export function makeOrderRef(deliveryDate, randomBytes) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const mmdd = deliveryDate.slice(5, 7) + deliveryDate.slice(8, 10);
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += alphabet[randomBytes[i] % alphabet.length];
  return `MC${mmdd}${suffix}`;
}

/** Constant-time string comparison, so the invite code can't be guessed by timing. */
export function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}
