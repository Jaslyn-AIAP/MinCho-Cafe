// Run: node --test tests/
// End-to-end test of the order function with Supabase, Turnstile and Telegram
// replaced by an in-memory fake (global fetch is stubbed).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost as placeOrder } from '../functions/api/orders.js';
import { onRequestPost as getMenu } from '../functions/api/menu.js';

const env = {
  SUPABASE_URL: 'https://fake.supabase.co',
  SUPABASE_SERVICE_KEY: 'service',
  TURNSTILE_SITE_KEY: 'site',
  TURNSTILE_SECRET_KEY: 'secret',
  IP_HASH_SALT: 'salt',
  TELEGRAM_BOT_TOKEN: 'tg',
  TELEGRAM_CHAT_ID: '-100',
};

let state;
beforeEach(() => {
  state = {
    settings: { id: 1, shop_name: 'MinCho Cafe', ordering_open: true, invite_code: 'TEA-1234', delivery_enabled: false,
      delivery_fee_cents: 500, min_order_cents: 0, cutoff_days: 1, cutoff_time: '23:59:00', paynow_number: '81234567',
      collection_note: 'At QQ place', retention_days: 90 },
    products: [
      { id: 'milk_tea', name: 'Hong Kong Milk Tea', description: '', price_per_litre_cents: 1800, active: true, sort_order: 1 },
      { id: 'lemon_tea', name: 'Hong Kong Lemon Tea', description: '', price_per_litre_cents: 1200, active: true, sort_order: 2 },
    ],
    sizes: [{ ml: 250, container: 'packet', active: true }, { ml: 500, container: 'bottle', active: true }, { ml: 1000, container: 'bottle', active: true }],
    dates: [{ id: 1, delivery_date: '2099-10-17', active: true, note: '' }, { id: 2, delivery_date: '2020-01-01', active: true, note: '' }],
    orders: [],
    telegram: [],
    turnstileOk: true,
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const ok = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (u.includes('turnstile')) return ok({ success: state.turnstileOk });
    if (u.includes('api.telegram.org')) { state.telegram.push(JSON.parse(init.body).text); return ok({ ok: true }); }
    const path = u.split('/rest/v1/')[1];
    if (path.startsWith('settings')) return ok([state.settings]);
    if (path.startsWith('products')) return ok(state.products);
    if (path.startsWith('bottle_sizes')) return ok(state.sizes);
    // Honour the "active only" filter, as Supabase does, so unticked dates are really tested
    if (path.startsWith('delivery_dates')) return ok(path.includes('active=eq.true') ? state.dates.filter((d) => d.active) : state.dates);
    if (path.startsWith('orders?select=id')) return ok(state.orders.slice(0, 5));
    if (path === 'orders' && init.method === 'POST') {
      const row = JSON.parse(init.body);
      state.orders.push(row);
      return ok([row], 201);
    }
    throw new Error('Unexpected fetch ' + u);
  };
});

const req = (body) => new Request('https://x/api/orders', {
  method: 'POST', body: JSON.stringify(body), headers: { 'CF-Connecting-IP': '1.2.3.4' },
});
const goodOrder = () => ({
  turnstileToken: 'tok', code: 'tea-1234', dateId: 1, name: 'Jas', phone: '9123 4567', fulfilment: 'collection',
  consent: true,
  items: [{ product_id: 'milk_tea', size_ml: 250, qty: 5 }, { product_id: 'milk_tea', size_ml: 500, qty: 5 }],
});

test('valid order is saved with server-side price and owners notified', async () => {
  const res = await placeOrder({ request: req(goodOrder()), env });
  const data = await res.json();
  assert.equal(res.status, 201, JSON.stringify(data));
  assert.equal(data.totalCents, 6750);
  assert.equal(data.paynowNumber, '81234567');
  assert.match(data.orderRef, /^MC1017-/);
  assert.equal(state.orders[0].total_cents, 6750);
  assert.equal(state.orders[0].address, null);
  assert.equal(state.orders[0].phone, '91234567');
  assert.notEqual(state.orders[0].ip_hash, '1.2.3.4');
  assert.match(state.telegram[0], /\$67\.50/);
  assert.match(state.telegram[0], /250 ml packet × 5/);
  assert.match(state.telegram[0], /500 ml bottle × 5/);
  assert.equal(state.orders[0].items[0].container, 'packet');
});

test('client-sent prices are ignored', async () => {
  const o = goodOrder();
  o.totalCents = 1; o.items[0].unit_price_cents = 1;
  const data = await (await placeOrder({ request: req(o), env })).json();
  assert.equal(data.totalCents, 6750);
});

test('rejections', async () => {
  const cases = [
    [(o) => { state.turnstileOk = false; return o; }, 403],
    [(o) => ({ ...o, code: 'WRONG' }), 403],
    [(o) => ({ ...o, dateId: 2 }), 409],              // past cutoff
    [(o) => ({ ...o, dateId: 99 }), 400],             // unknown date
    [(o) => ({ ...o, phone: '123' }), 400],
    [(o) => ({ ...o, consent: false }), 400],
    [(o) => ({ ...o, fulfilment: 'delivery', address: 'Blk 1' }), 400], // delivery off
    [(o) => ({ ...o, items: [] }), 400],
    [(o) => { state.settings.ordering_open = false; return o; }, 403],
    [(o) => { state.settings.min_order_cents = 10000; return o; }, 400],
  ];
  for (const [mutate, status] of cases) {
    const before = state.orders.length;
    state.turnstileOk = true; state.settings.ordering_open = true; state.settings.min_order_cents = 0;
    const res = await placeOrder({ request: req(mutate(goodOrder())), env });
    assert.equal(res.status, status, mutate.toString());
    assert.equal(state.orders.length, before);
  }
});

test('delivery adds fee and keeps address when enabled', async () => {
  state.settings.delivery_enabled = true;
  const data = await (await placeOrder({ request: req({ ...goodOrder(), fulfilment: 'delivery', address: 'Blk 123 Bishan St 12 #05-67' }), env })).json();
  assert.equal(data.totalCents, 6750 + 500);
  assert.equal(state.orders[0].address, 'Blk 123 Bishan St 12 #05-67');
});

test('collection orders never store an address even if sent', async () => {
  await placeOrder({ request: req({ ...goodOrder(), address: 'sneaky' }), env });
  assert.equal(state.orders[0].address, null);
});

test('rate limit after 5 orders', async () => {
  state.orders = Array.from({ length: 5 }, () => ({}));
  const res = await placeOrder({ request: req(goodOrder()), env });
  assert.equal(res.status, 429);
});

test('menu requires invite code and hides past dates', async () => {
  const bad = await getMenu({ request: new Request('https://x', { method: 'POST', body: '{"code":"nope"}' }), env });
  assert.equal(bad.status, 403);
  const good = await getMenu({ request: new Request('https://x', { method: 'POST', body: '{"code":"TEA-1234"}' }), env });
  const data = await good.json();
  assert.equal(data.dates.length, 1);
  assert.equal(data.products[0].bottlePrices[250], 450);
  assert.deepEqual(data.sizes, [{ ml: 250, container: 'packet' }, { ml: 500, container: 'bottle' }, { ml: 1000, container: 'bottle' }]);
  assert.equal(JSON.stringify(data).includes('81234567'), false, 'PayNow number only revealed after ordering');
});

test('server applies free delivery threshold', async () => {
  state.settings.delivery_enabled = true;
  state.settings.free_delivery_min_cents = 5000;
  const big = await (await placeOrder({ request: req({ ...goodOrder(), fulfilment: 'delivery', address: 'Blk 1 Bishan St 11 #01-01' }), env })).json();
  assert.equal(big.deliveryFeeCents, 0);
  assert.equal(big.totalCents, 6750);
  const small = await (await placeOrder({ request: req({ ...goodOrder(), fulfilment: 'delivery', address: 'Blk 1 Bishan St 11 #01-01', items: [{ product_id: 'lemon_tea', size_ml: 1000, qty: 1 }] }), env })).json();
  assert.equal(small.deliveryFeeCents, 500);
  assert.equal(small.totalCents, 1700);
});

test('an unticked (inactive) date is hidden from the menu and refused for orders', async () => {
  state.dates.push({ id: 3, delivery_date: '2099-10-24', active: false, note: '' });
  const menu = await (await getMenu({ request: new Request('https://x', { method: 'POST', body: '{"code":"TEA-1234"}' }), env })).json();
  assert.deepEqual(menu.dates.map((d) => d.date), ['2099-10-17']);
  const res = await placeOrder({ request: req({ ...goodOrder(), dateId: 3 }), env });
  assert.equal(res.status, 400);
  assert.equal(state.orders.length, 0);
  // Tick it again: now it is offered and accepted
  state.dates[2].active = true;
  assert.equal((await placeOrder({ request: req({ ...goodOrder(), dateId: 3 }), env })).status, 201);
});
