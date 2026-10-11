// Run: node --test tests/
// Unit tests for pricing and cutoff rules, using the real sample orders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceItems, bottlePriceCents, cutoffInstant, isDateOpen, normalisePhone, makeOrderRef, safeEqual } from '../lib/rules.js';

const products = [
  { id: 'milk_tea', name: 'Hong Kong Milk Tea', price_per_litre_cents: 1800, active: true, sort_order: 1 },
  { id: 'lemon_tea', name: 'Hong Kong Lemon Tea', price_per_litre_cents: 1200, active: true, sort_order: 2 },
];
const sizes = [{ ml: 250, container: 'packet', active: true }, { ml: 500, container: 'bottle', active: true }, { ml: 1000, container: 'bottle', active: true }];
const total = (items) => priceItems(items, products, sizes).subtotalCents;

test('bottle prices are pro-rata per litre', () => {
  assert.equal(bottlePriceCents(1800, 250), 450);
  assert.equal(bottlePriceCents(1800, 500), 900);
  assert.equal(bottlePriceCents(1200, 250), 300);
  assert.equal(bottlePriceCents(1200, 1000), 1200);
});

test('sample orders from the owners match their totals', () => {
  // Vivi ($30): 1L milk + 1L lemon
  assert.equal(total([{ product_id: 'milk_tea', size_ml: 1000, qty: 1 }, { product_id: 'lemon_tea', size_ml: 1000, qty: 1 }]), 3000);
  // Joelle / Cynthia ($30): 250×2 + 500×1 of each
  assert.equal(total([
    { product_id: 'milk_tea', size_ml: 250, qty: 2 }, { product_id: 'milk_tea', size_ml: 500, qty: 1 },
    { product_id: 'lemon_tea', size_ml: 250, qty: 2 }, { product_id: 'lemon_tea', size_ml: 500, qty: 1 },
  ]), 3000);
  // Vivian ($12): 1L lemon
  assert.equal(total([{ product_id: 'lemon_tea', size_ml: 1000, qty: 1 }]), 1200);
  // Jas ($67.50): milk 250×5 + 500×5
  assert.equal(total([{ product_id: 'milk_tea', size_ml: 250, qty: 5 }, { product_id: 'milk_tea', size_ml: 500, qty: 5 }]), 6750);
});

test('duplicate lines are merged, zero lines dropped', () => {
  const r = priceItems([
    { product_id: 'milk_tea', size_ml: 250, qty: 2 },
    { product_id: 'milk_tea', size_ml: 250, qty: 3 },
    { product_id: 'lemon_tea', size_ml: 500, qty: 0 },
  ], products, sizes);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].qty, 5);
  assert.equal(r.subtotalCents, 2250);
});

test('tampered or invalid input is rejected', () => {
  const bad = [
    [{ product_id: 'milk_tea', size_ml: 250, qty: -1 }],
    [{ product_id: 'milk_tea', size_ml: 250, qty: 1.5 }],
    [{ product_id: 'milk_tea', size_ml: 333, qty: 1 }],
    [{ product_id: 'bubble_tea', size_ml: 250, qty: 1 }],
    [{ product_id: 'milk_tea', size_ml: '250', qty: 1 }],
    [{ product_id: 'milk_tea', size_ml: 250, qty: 51 }],
    [],
    'not a list',
    [{ product_id: 'milk_tea', size_ml: 250, qty: 0 }],
  ];
  for (const items of bad) assert.equal(priceItems(items, products, sizes).ok, false, JSON.stringify(items));
});

test('inactive product or size cannot be ordered', () => {
  const p2 = products.map((p) => (p.id === 'lemon_tea' ? { ...p, active: false } : p));
  assert.equal(priceItems([{ product_id: 'lemon_tea', size_ml: 250, qty: 1 }], p2, sizes).ok, false);
  const s2 = sizes.map((s) => (s.ml === 250 ? { ...s, active: false } : s));
  assert.equal(priceItems([{ product_id: 'milk_tea', size_ml: 250, qty: 1 }], products, s2).ok, false);
});

test('cutoff: 17 Oct closes 16 Oct 23:59 Singapore time', () => {
  const settings = { cutoff_days: 1, cutoff_time: '23:59:00' };
  assert.equal(cutoffInstant('2026-10-17', 1, '23:59:00').toISOString(), '2026-10-16T15:59:00.000Z');
  assert.equal(isDateOpen('2026-10-17', settings, new Date('2026-10-16T15:58:59Z')), true);
  assert.equal(isDateOpen('2026-10-17', settings, new Date('2026-10-16T16:00:00Z')), false);
  // Month boundary: 1 Nov closes 31 Oct
  assert.equal(cutoffInstant('2026-11-01', 1, '18:00').toISOString(), '2026-10-31T10:00:00.000Z');
});

test('phone normalisation', () => {
  assert.equal(normalisePhone('8123 4567'), '81234567');
  assert.equal(normalisePhone('+65 8123-4567'), '81234567');
  assert.equal(normalisePhone('6581234567'), '81234567');
  assert.equal(normalisePhone('1234567'), null);
  assert.equal(normalisePhone('12345678'), null);
  assert.equal(normalisePhone('61234567'), null); // landline
  assert.equal(normalisePhone('31234567'), null); // virtual number
});

test('order reference format', () => {
  const ref = makeOrderRef('2026-10-17', new Uint8Array([0, 1, 2, 3]));
  assert.match(ref, /^MC1017-[A-Z2-9]{4}$/);
});

test('safeEqual', () => {
  assert.equal(safeEqual('ABC', 'ABC'), true);
  assert.equal(safeEqual('ABC', 'ABD'), false);
  assert.equal(safeEqual('ABC', 'ABCD'), false);
});

test('a size or drink added later is priced pro-rata on the server', () => {
  const s2 = [...sizes, { ml: 350, active: true }];
  const p2 = [...products, { id: 'yuenyeung', name: 'Yuenyeung', price_per_litre_cents: 1600, active: true, sort_order: 3 }];
  const r = priceItems([{ product_id: 'milk_tea', size_ml: 350, qty: 2 }, { product_id: 'yuenyeung', size_ml: 500, qty: 1 }], p2, s2);
  assert.equal(r.ok, true);
  assert.equal(r.subtotalCents, 630 * 2 + 800);
});

test('free delivery from a set amount, fee below it', async () => {
  const { deliveryFeeCents } = await import('../lib/rules.js');
  const s = { delivery_fee_cents: 500, free_delivery_min_cents: 5000 };
  assert.equal(deliveryFeeCents('delivery', 4999, s), 500);
  assert.equal(deliveryFeeCents('delivery', 5000, s), 0);   // exactly $50 counts as free
  assert.equal(deliveryFeeCents('delivery', 6750, s), 0);
  assert.equal(deliveryFeeCents('collection', 1200, s), 0);
  assert.equal(deliveryFeeCents('delivery', 99999, { delivery_fee_cents: 500, free_delivery_min_cents: 0 }), 500); // 0 = never free
});

test('250 ml is a packet; 500 ml and 1 L are bottles', async () => {
  const { itemSize } = await import('../lib/rules.js');
  const r = priceItems([{ product_id: 'milk_tea', size_ml: 250, qty: 2 }, { product_id: 'lemon_tea', size_ml: 1000, qty: 1 }], products, sizes);
  assert.deepEqual(r.items.map((i) => itemSize(i.size_ml, i.container)), ['250 ml packet', '1 L bottle']);
  assert.equal(itemSize(500), '500 ml bottle', 'older orders without a container read as bottles');
});

// ---------------------------------------------------------------------------
// A size is volume + container (migration 004): 500 ml packet and 500 ml bottle
// ---------------------------------------------------------------------------
const both = [
  { ml: 250, container: 'packet', active: true },
  { ml: 500, container: 'bottle', active: true },
  { ml: 500, container: 'packet', active: true },
  { ml: 1000, container: 'bottle', active: false },
  { ml: 1000, container: 'packet', active: true },
];

test('500 ml packet and 500 ml bottle are separate lines at the same price', async () => {
  const { itemSize } = await import('../lib/rules.js');
  const r = priceItems([
    { product_id: 'milk_tea', size_ml: 500, container: 'packet', qty: 2 },
    { product_id: 'milk_tea', size_ml: 500, container: 'bottle', qty: 1 },
    { product_id: 'milk_tea', size_ml: 500, container: 'packet', qty: 1 },   // merged with the first line
  ], products, both);
  assert.equal(r.ok, true);
  assert.deepEqual(r.items.map((i) => `${itemSize(i.size_ml, i.container)} x${i.qty} @${i.unit_price_cents}`),
    ['500 ml bottle x1 @900', '500 ml packet x3 @900']);
  assert.equal(r.subtotalCents, 900 * 4);
  assert.equal(r.totalMl, 2000);
});

test('an unticked container is refused even if the same volume is on sale in another', () => {
  assert.equal(priceItems([{ product_id: 'milk_tea', size_ml: 1000, container: 'bottle', qty: 1 }], products, both).ok, false);
  assert.equal(priceItems([{ product_id: 'milk_tea', size_ml: 1000, container: 'packet', qty: 1 }], products, both).ok, true);
  assert.equal(priceItems([{ product_id: 'milk_tea', size_ml: 500, container: 'can', qty: 1 }], products, both).ok, false);
});

test('an item without a container is accepted only when the volume is unambiguous', () => {
  // 1000 ml: only the packet is on sale, so a page loaded before the change still works
  const r = priceItems([{ product_id: 'milk_tea', size_ml: 1000, qty: 1 }], products, both);
  assert.equal(r.ok, true);
  assert.equal(r.items[0].container, 'packet');
  // 500 ml: packet AND bottle on sale, so it is ambiguous and refused with a refresh hint
  const amb = priceItems([{ product_id: 'milk_tea', size_ml: 500, qty: 1 }], products, both);
  assert.equal(amb.ok, false);
  assert.match(amb.error, /refresh/);
});

test('volume labels: ml below 1 L, litres from 1 L, prices pro-rata with rounding', async () => {
  const { sizeLabel, bottlePriceCents } = await import('../lib/rules.js');
  assert.deepEqual([250, 500, 750, 999, 1000, 1250, 1500, 2000].map(sizeLabel),
    ['250 ml', '500 ml', '750 ml', '999 ml', '1 L', '1.25 L', '1.5 L', '2 L']);
  assert.equal(bottlePriceCents(1800, 1000), 1800);
  assert.equal(bottlePriceCents(1800, 500), 900);
  assert.equal(bottlePriceCents(1200, 250), 300);
  assert.equal(bottlePriceCents(1200, 333), 400);   // 399.6 cents rounds to $4.00
  assert.equal(bottlePriceCents(1800, 330), 594);
});
