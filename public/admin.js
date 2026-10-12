// =============================================================================
// admin.js — owners' page (owners: Ming, QQ, Jaslyn; customers know Ming as "Master Ming")
// -----------------------------------------------------------------------------
// Talks to Supabase directly using the PUBLISHABLE key + the owner's login.
// That is safe because the database only lets users listed in `admins` read
// or change anything (Row Level Security, see supabase/schema.sql).
//
// Destructive actions (delete date, new invite code, purge old orders) use a
// two-tap confirm: the first tap changes the button to "Tap again to confirm".
// =============================================================================
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const money = (cents) => `$${(cents / 100).toFixed(2)}`;
  const sizeLabel = (ml) => (ml >= 1000 ? `${ml / 1000} L` : `${ml} ml`);
  // "250 ml packet" / "1 L bottle". A size is volume + container, so 500 ml can be
  // both a packet and a bottle. Order items saved before containers existed were bottles.
  const itemSize = (ml, container) => `${sizeLabel(ml)} ${container || 'bottle'}`;
  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    for (const c of children) node.append(c);
    return node;
  };
  const todaySgt = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

  // Order cutoff for a date, as an instant. Mirrors cutoffInstant() in lib/rules.js,
  // which is what the server uses; keep the two in step if the rule changes.
  // Example: date 2026-10-17, 1 day before at 23:59 → Fri 16 Oct, 11:59 pm Singapore time.
  // `rule` defaults to the saved settings; pass { cutoff_days, cutoff_time } to try a new rule.
  function cutoffFor(isoDate, rule = settings) {
    const [y, m, d] = isoDate.split('-').map(Number);
    const [hh, mm, ss = 0] = String(rule.cutoff_time).split(':').map(Number);
    return new Date(Date.UTC(y, m - 1, d - rule.cutoff_days, hh, mm, ss) - 8 * 3600e3);
  }
  const formatSgt = (when, opts) => new Intl.DateTimeFormat('en-SG', { timeZone: 'Asia/Singapore', ...opts }).format(when);
  // Payment steps (migration 005). "Confirmed in bank" can only be set by the owner
  // whose bank account receives PayNow; the database enforces this, the page just
  // greys the option out for everyone else.
  const PAYMENT = [
    ['unpaid', 'Not paid'],
    ['screenshot', 'Screenshot received'],
    ['confirmed', 'Confirmed in bank'],
    ['refunded', 'Refunded'],          // only for cancelled orders (migration 006)
  ];
  const paymentLabel = (v) => (PAYMENT.find(([value]) => value === v) || [v, v])[1];
  let me = { email: '', can_confirm_payments: false };   // the logged-in owner

  let sb;                 // Supabase client
  let settings, products, sizes, dates = [];
  let currentOrders = [];

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  /** Show a Supabase error in a status element (or the console). */
  /** Show a status line in a message element: kind 'ok' (green, ✓, with time) or 'bad' (red, ✗, with time). */
  // `fields` (optional): the input(s) that caused a refusal. They get a red border
  // and the cursor, so the problem shows where the owner was typing.
  function say(el, text, kind, fields) {
    el.classList.remove('status-ok', 'status-warn', 'status-bad', 'flash');
    if (kind) el.classList.add(`status-${kind}`);
    // Failures get a cross and capitalised wording, so they don't rely on colour alone.
    // The timestamp goes on its own last line, e.g. "2026-10-11 00:20" (Singapore time).
    const symbol = { ok: '✓', warn: '⚠', bad: '✗' }[kind];
    el.textContent = symbol ? `${symbol} ${text}\n${stampSgt()}` : text;
    if (!kind) return; // "Saving…" and similar: no flash, no scrolling
    void el.offsetWidth;           // restart the flash animation if it is already showing
    el.classList.add('flash');
    // On a phone the message can be below the screen edge: bring it into view
    const box = el.getBoundingClientRect();
    if (box.top < 0 || box.bottom > window.innerHeight) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (kind === 'bad' && fields) markInvalid(fields);
  }

  /** Red border on the field(s) that caused a refusal; cleared as soon as the owner edits it. */
  function markInvalid(fields) {
    const list = [].concat(fields).filter(Boolean);
    for (const f of list) {
      f.classList.add('invalid');
      f.setAttribute('aria-invalid', 'true');
      const clear = () => { f.classList.remove('invalid'); f.removeAttribute('aria-invalid'); };
      f.addEventListener('input', clear, { once: true });
      f.addEventListener('change', clear, { once: true });
    }
    list[0]?.focus({ preventScroll: true });
  }

  /** Briefly highlight an existing item (e.g. the size or date that already exists). */
  function flashItem(node) {
    if (!node) return;
    node.classList.remove('flash-item');
    void node.offsetWidth;
    node.classList.add('flash-item');
  }

  /** Current Singapore time as "2026-10-11 00:20", whatever the device's time zone. */
  // ISO 8601 timestamp in Singapore time, offset included, e.g. "2026-10-10T22:25:31+08:00".
  // Accepts a Date or a database timestamp such as "2026-10-10T14:25:31.251934+00:00"
  // (UTC from Supabase). Fractions beyond milliseconds are trimmed first, because some
  // browsers reject 6-digit fractions. Singapore has no daylight saving: always +08:00.
  const isoSgt = (value) => {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(String(value).replace(/(\.\d{3})\d+/, '$1'));
    if (Number.isNaN(date.getTime())) return String(value);
    return new Date(date.getTime() + 8 * 3600e3).toISOString().slice(0, 19) + '+08:00';
  };
  const stampSgt = () => isoSgt(new Date());

  /** A Singapore date-time as "Tue 13 Oct 2026, 11:59 pm" (matches the order page's style, plus the year). */
  function longSgt(when) {
    const t = new Date(when.getTime() + 8 * 3600e3); // read the UTC fields as Singapore wall-clock time
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][t.getUTCDay()];
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][t.getUTCMonth()];
    const h = t.getUTCHours();
    const time = `${h % 12 || 12}:${String(t.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
    return `${day} ${t.getUTCDate()} ${month} ${t.getUTCFullYear()}, ${time}`;
  }

  /** Turn a Supabase sign-in error into a plain message. */
  function loginMessage(error) {
    const m = String(error?.message || '');
    if (/invalid login credentials/i.test(m)) return 'Wrong email or password.';
    if (error?.status === 429 || /rate limit|too many/i.test(m)) return 'Too many tries. Wait a few minutes, then try again.';
    if (/email not confirmed/i.test(m)) return 'This email has not been confirmed. Ask another owner to re-add you.';
    if (/fetch|network/i.test(m)) return 'Could not reach the login service. Check your connection and try again.';
    return `Could not log in: ${m || 'unknown error'}`;
  }

  function report(error, target) {
    console.error(error);
    const msg = error?.message || String(error);
    if (target) target.textContent = `Error: ${msg}`;
    return msg;
  }

  /** Two-tap confirmation for destructive buttons. */
  function confirmTap(button, label, action) {
    let armed = false;
    let timer;
    button.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        button.textContent = 'Tap again to confirm';
        timer = setTimeout(() => { armed = false; button.textContent = label; }, 4000);
        return;
      }
      clearTimeout(timer);
      armed = false;
      button.textContent = label;
      await action();
    });
  }

  async function copy(text, button) {
    const original = button.textContent;
    try { await navigator.clipboard.writeText(text); button.textContent = 'Copied'; }
    catch { button.textContent = 'Copy failed: select the text'; }
    setTimeout(() => { button.textContent = original; }, 2000);
  }

  // ---------------------------------------------------------------------------
  // Start-up and login
  // ---------------------------------------------------------------------------
  async function init() {
    const res = await fetch('/api/admin-config');
    const cfg = await res.json();
    if (!res.ok) { document.body.append(el('p', { className: 'wrap error', textContent: cfg.error })); return; }
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);

    const { data } = await sb.auth.getSession();
    if (data.session) { await enter(data.session); return; }
    // No owners yet? Show the one-time setup form instead of the login.
    const setup = await fetch('/api/setup').then((r) => r.json()).catch(() => ({ needed: false }));
    if (setup.needed) $('setup').hidden = false;
    else $('login').hidden = false;
  }

  // One-time creation of the first owner, then log straight in.
  $('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const box = $('setup-error');
    box.hidden = true;
    const email = $('setup-email').value.trim();
    const password = $('setup-password').value;
    const res = await fetch('/api/setup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setupCode: $('setup-code').value, email, password }),
    }).catch(() => null);
    const out = res ? await res.json().catch(() => ({})) : { error: 'Network problem. Please try again.' };
    if (!res || !res.ok) { box.textContent = out.error || 'Setup failed.'; box.hidden = false; return; }
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) { box.textContent = 'Owner created, but logging in failed. Reload and log in.'; box.hidden = false; return; }
    $('setup').hidden = true;
    await enter(data.session);
  });

  /** Call one of our own owner-only server routes with the owner's access token. */
  async function ownerApi(method, body) {
    const { data } = await sb.auth.getSession();
    const res = await fetch('/api/owners', {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${data.session?.access_token || ''}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const out = await res.json().catch(() => ({}));
    return { ok: res.ok, data: out };
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const box = $('login-error');
    box.hidden = true;
    const { data, error } = await sb.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
    if (error) { console.error(error); box.textContent = loginMessage(error); box.hidden = false; return; }
    await enter(data.session);
  });

  $('logout').addEventListener('click', async () => {
    await sb.auth.signOut();
    location.reload();
  });

  async function enter(session) {
    // Confirm this login is actually an owner
    const { data: row } = await sb.from('admins').select('*').eq('user_id', session.user.id).maybeSingle();
    if (row) me = { email: row.email, can_confirm_payments: Boolean(row.can_confirm_payments) };
    if (!row) {
      await sb.auth.signOut();
      $('login').hidden = false;
      $('login-error').textContent = 'This account is not an owner account.';
      $('login-error').hidden = false;
      return;
    }
    $('login').hidden = true;
    $('app').hidden = false;
    $('who').textContent = `Logged in as ${me.email}`;
    await loadAll();
  }

  async function loadAll() {
    const [s, p, z, d] = await Promise.all([
      sb.from('settings').select('*').eq('id', 1).single(),
      sb.from('products').select('*').order('sort_order'),
      sb.from('bottle_sizes').select('*').order('ml').order('container'),
      sb.from('delivery_dates').select('*').order('delivery_date'),
    ]);
    for (const r of [s, p, z, d]) if (r.error) return say($('shop-status'), `FAILED TO LOAD. ${report(r.error)} Reload the page to try again.`, 'bad');
    settings = s.data; products = p.data; sizes = z.data; dates = d.data;
    renderDateSelect();
    renderDates();
    renderMenu();
    renderSettings();
    renderShopStatus();
    await loadOrders();
    await loadOwners();
  }

  // ---------------------------------------------------------------------------
  // "What customers see now" line above the tabs. Same rule as the order page:
  //   Shop open unticked            → "Shop closed" sign
  //   no active date before cutoff  → "Orders paused" sign (shop is open, but nothing to order)
  //   otherwise                     → customers can order
  // Re-checked every minute, because a cutoff can pass while this page is open.
  // ---------------------------------------------------------------------------
  function renderShopStatus() {
    const box = $('shop-status');
    if (!settings) return;
    const now = Date.now();
    const open = dates.filter((d) => d.active && now <= cutoffFor(d.delivery_date).getTime());
    box.classList.remove('status-ok', 'status-warn', 'status-bad');
    const goTo = (tab, label) => {
      const btn = el('button', { type: 'button', className: 'link', textContent: label });
      btn.addEventListener('click', () => document.querySelector(`[data-tab="${tab}"]`).click());
      return btn;
    };
    // Everything that stops customers ordering, listed together so owners see it all at once.
    // (Customers see only one sign: Shop closed first, then Orders paused.)
    const missing = [];
    if (!settings.ordering_open) missing.push(['Shop open is unticked. ', goTo('settings', 'Tick Shop open in Settings'), ', then Save.']);
    if (open.length === 0) missing.push(['No date is open for orders. ', goTo('dates', 'Add a future date in Dates'), '.']);
    if (!sizes.some((s) => s.active)) missing.push(['No size is on sale. ', goTo('menu', 'Tick or add a size in Menu & prices'), '.']);
    if (!products.some((p) => p.active)) missing.push(['No drink is on the menu. ', goTo('menu', 'Tick "On the menu" for a drink in Menu & prices'), ', then Save.']);
    if (missing.length) {
      // Red when the owners closed the shop; amber when it is open but something is missing
      box.classList.add(settings.ordering_open ? 'status-warn' : 'status-bad');
      const sign = settings.ordering_open ? '⚠ Customers see the "Orders paused" sign.' : '✗ Customers see the "Shop closed" sign.';
      box.replaceChildren(sign, missing.length === 1 ? ' To take orders:' : ` To take orders, fix all ${missing.length}:`,
        ...missing.flatMap((line) => ['\n• ', ...line]));
    } else {
      box.classList.add('status-ok');
      const list = open.map((d) => `${formatSgt(new Date(`${d.delivery_date}T12:00:00+08:00`), { weekday: 'short', day: 'numeric', month: 'short' })} (orders close ${formatSgt(cutoffFor(d.delivery_date), { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })})`);
      box.replaceChildren(`✓ Taking orders for ${list.join('; ')}.`);
    }
  }
  setInterval(renderShopStatus, 60e3);

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------
  document.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('[data-tab]').forEach((t) => {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        $(`tab-${t.dataset.tab}`).hidden = !on;
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Orders tab
  // ---------------------------------------------------------------------------
  function renderDateSelect() {
    const select = $('order-date');
    const previous = select.value;
    select.replaceChildren(...[...dates].reverse().map((d) =>
      el('option', { value: String(d.id), textContent: `${d.delivery_date}${d.active ? '' : ' (inactive)'}` })));
    // Default: the next upcoming date, otherwise the latest
    const upcoming = dates.find((d) => d.delivery_date >= todaySgt());
    // Keep the owner's choice, unless that date no longer exists (e.g. just deleted)
    const stillThere = dates.some((d) => String(d.id) === previous);
    select.value = stillThere ? previous : String((upcoming || dates[dates.length - 1] || {}).id || '');
  }
  $('order-date').addEventListener('change', loadOrders);
  $('refresh').addEventListener('click', loadOrders);

  async function loadOrders() {
    const dateId = Number($('order-date').value);
    if (!dateId) { currentOrders = []; renderOrders(); return; }
    const { data, error } = await sb.from('orders').select('*').eq('delivery_date_id', dateId).order('created_at');
    if (error) return say($('orders-msg'), `FAILED TO LOAD ORDERS. ${report(error)}`, 'bad');
    currentOrders = data;
    renderOrders();
    await loadUnconfirmed();
  }

  function renderOrders() {
    const live = currentOrders.filter((o) => o.status !== 'cancelled');

    // --- Brewing summary -----------------------------------------------------------
    // Big number: everything ordered for this date (cancelled left out), so the brewing
    // plan doesn't shrink on collection day. Second line: what is still to hand out
    // (orders not yet marked Collected).
    const sizeBreakdown = (orders, productId) => {
      let ml = 0;
      const bySize = new Map();
      for (const o of orders) for (const i of o.items) if (i.product_id === productId) {
        ml += i.size_ml * i.qty;
        // Counted per volume AND container: 500 ml packets and 500 ml bottles are filled differently
        const key = `${i.size_ml}|${i.container || 'bottle'}`;
        bySize.set(key, (bySize.get(key) || 0) + i.qty);
      }
      // "250 ml packet × 9 | 500 ml bottle × 7 | 1 L bottle × 1": sorted by volume, then container,
      // each item kept on one line
      const parts = [...bySize.entries()]
        .map(([key, n]) => { const [v, container] = key.split('|'); return { v: Number(v), container, n }; })
        .sort((a, b) => a.v - b.v || a.container.localeCompare(b.container))
        .map(({ v, container, n }) => el('span', { className: 'nowrap', textContent: `${itemSize(v, container)} × ${n}` }));
      return { ml, parts: parts.flatMap((part, i) => (i ? [' | ', part] : [part])) };
    };
    const litres = (ml) => `${(ml / 1000).toFixed(2)} L`;
    const notCollected = live.filter((o) => !o.collected_at);

    const brew = $('brew');
    brew.replaceChildren();
    for (const p of products) {
      const all = sizeBreakdown(live, p.id);
      const left = sizeBreakdown(notCollected, p.id);
      const leftLine = all.ml === 0 ? []
        : left.ml === 0 ? [el('div', { className: 'hint still', textContent: 'All collected ✓' })]
          : [el('div', { className: 'hint still' }, el('b', { textContent: `Still to collect: ${litres(left.ml)}` }), el('br'), ...left.parts)];
      brew.append(el('div', { className: 'tile' },
        el('div', { className: 'hint', textContent: p.name }),
        el('div', { className: 'big', textContent: litres(all.ml) }),
        el('div', { className: 'hint' }, ...(all.parts.length ? all.parts : ['None'])),
        ...leftLine));
    }
    // Money: only "Confirmed in bank" counts as received. Screenshots are claims.
    const sum = (list) => list.reduce((s, o) => s + o.total_cents, 0);
    const total = sum(live);
    const confirmed = sum(live.filter((o) => o.payment_status === 'confirmed'));
    const shotOnly = sum(live.filter((o) => o.payment_status === 'screenshot'));
    const unpaid = total - confirmed - shotOnly;
    const handedUnconfirmed = live.filter((o) => o.collected_at && o.payment_status !== 'confirmed');
    const refundsOwed = currentOrders.filter((o) => o.status === 'cancelled' && o.payment_status === 'confirmed');
    brew.append(el('div', { className: 'tile' },
      el('div', { className: 'hint', textContent: plural(live.length, 'order') }),
      el('div', { className: 'big', textContent: money(total) }),
      el('div', { className: 'hint' },
        el('b', { textContent: `${money(confirmed)} confirmed in bank` }), el('br'),
        `${money(shotOnly)} screenshot only, not confirmed`, el('br'),
        `${money(unpaid)} not paid`),
      handedUnconfirmed.length
        ? el('div', { className: 'hint still owed', textContent: `⚠ ${money(sum(handedUnconfirmed))} handed over but not confirmed in bank (${plural(handedUnconfirmed.length, 'order')})` })
        : '',
      refundsOwed.length
        ? el('div', { className: 'hint still owed', textContent: `✗ Refunds owed: ${money(sum(refundsOwed))} (${plural(refundsOwed.length, 'cancelled order')})` })
        : ''));

    // --- Order table --------------------------------------------------------------
    const table = $('orders-table');
    const head = el('thead', {}, el('tr', {}, ...['Ref', 'Customer', 'Items', 'Total', 'Status'].map((h) => el('th', { textContent: h }))));
    const body = el('tbody');
    if (!currentOrders.length) body.append(el('tr', {}, el('td', { colSpan: 5, className: 'hint', textContent: 'No orders for this date yet.' })));
    for (const o of currentOrders) {
      const controls = orderControls(o);
      const items = o.items.map((i) => `${i.product_name.replace('Hong Kong ', '')} ${itemSize(i.size_ml, i.container)} × ${i.qty}`).join('\n');
      body.append(el('tr', {},
        el('td', {}, el('strong', { textContent: o.order_ref }), el('br'), ...orderBadges(o)),
        el('td', {},
          document.createTextNode(o.customer_name), el('br'),
          // Shown as "8123 0001"; tapping opens a WhatsApp chat (wa.me needs the
          // country code, digits only: 65 + the 8-digit Singapore number).
          el('a', {
            className: 'wa', href: `https://wa.me/65${o.phone}`, target: '_blank', rel: 'noopener noreferrer',
            textContent: o.phone.replace(/^(\d{4})(\d{4})$/, '$1 $2'), title: `WhatsApp ${o.customer_name}`,
          }),
          o.address ? el('div', { className: 'hint', textContent: `📍 ${o.address}` }) : '',
          o.notes ? el('div', { className: 'hint', textContent: `Note: ${o.notes}` }) : ''),
        el('td', { className: 'pre', textContent: items }),
        el('td', { textContent: money(o.total_cents) }),
        el('td', {}, ...controls)));
    }
    table.replaceChildren(head, body);
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // Who did something: the owner's display name as the database stored it (e.g. "QQ").
  // Older stamps may hold a login email instead; show just the part before "@".
  const shortWho = (who) => (String(who || '').includes('@') ? String(who).split('@')[0] : String(who || ''));
  // Same format as the ✓ / ✗ messages: "2026-10-11T21:40:05+08:00"
  const when = isoSgt;

  /** Coloured labels next to the order reference. */
  function orderBadges(o) {
    if (o.status === 'cancelled') {
      // A cancelled order may still have money attached: make that impossible to miss
      const extra = {
        screenshot: el('span', { className: 'pill awaiting', textContent: 'Check payment, refund if received' }),
        confirmed: el('span', { className: 'pill danger', textContent: 'Refund needed' }),
        refunded: el('span', { className: 'pill collected', textContent: 'Refunded' }),
      }[o.payment_status];
      return [el('span', { className: 'pill cancelled', textContent: 'Cancelled' }), ...(extra ? [' ', extra] : [])];
    }
    const pay = { unpaid: ['awaiting', 'Not paid'], screenshot: ['awaiting', 'Screenshot only'], confirmed: ['paid', 'Confirmed'] }[o.payment_status] || ['awaiting', o.payment_status];
    const out = [el('span', { className: `pill ${pay[0]}`, textContent: pay[1] })];
    if (o.collected_at) {
      out.push(' ', o.payment_status === 'confirmed'
        ? el('span', { className: 'pill collected', textContent: 'Collected' })
        : el('span', { className: 'pill danger', textContent: 'Collected, payment not confirmed' }));
    }
    return out;
  }


  /** Payment dropdown, Collected tick box, Cancel/Restore, and the who/when record. */
  function orderControls(o) {
    const msg = $('orders-msg');
    const save = async (change, okText) => {
      const { error } = await sb.from('orders').update(change).eq('id', o.id);
      if (error) {
        // 42501 = no right to confirm/refund; 22023 = refund before confirming. The database's
        // own message explains it; anything else gets the general error text.
        const text = ['42501', '22023'].includes(error.code) ? error.message : report(error);
        say(msg, `FAILED TO SAVE. ${o.order_ref} is unchanged. ${text}`, 'bad');
        renderOrders();
        return false;
      }
      await loadOrders();   // reload so the database's who/when stamps show
      say(msg, okText, 'ok');
      return true;
    };
    const name = `${o.order_ref} (${o.customer_name})`;
    const cancelled = o.status === 'cancelled';

    // Payment dropdown. Confirmed and Refunded are money in/out of QQ's account, so only
    // she can set or undo them (the database enforces this; here they're just greyed out).
    // Refunded is offered only on cancelled orders, and only once confirmed in the bank.
    const qqOnly = ['confirmed', 'refunded'];
    const locked = qqOnly.includes(o.payment_status) && !me.can_confirm_payments;
    const options = PAYMENT.filter(([v]) => v !== 'refunded' || cancelled || o.payment_status === 'refunded');
    const payment = el('select', { ariaLabel: `Payment for ${o.order_ref}`, disabled: locked },
      ...options.map(([v, label]) => el('option', {
        value: v, selected: o.payment_status === v,
        disabled: v !== o.payment_status && (
          (qqOnly.includes(v) && !me.can_confirm_payments)
          || (v === 'refunded' && o.payment_status !== 'confirmed')),
        textContent: qqOnly.includes(v) && !me.can_confirm_payments ? `${label} (QQ only)` : label,
      })));
    payment.addEventListener('change', () => save({ payment_status: payment.value }, `${name}: payment set to "${paymentLabel(payment.value)}".`));

    if (cancelled) {
      const restore = el('button', { type: 'button', className: 'small secondary', textContent: 'Restore order' });
      confirmTap(restore, 'Restore order', () => save({ status: 'active' }, `${name} restored.`));
      return [payment, el('div', { className: 'row order-actions' }, restore), auditLine(o)];
    }

    // Collected: handing over before the money is confirmed is where sellers lose money
    const collected = el('input', { type: 'checkbox', checked: Boolean(o.collected_at), ariaLabel: `Collected ${o.order_ref}` });
    collected.addEventListener('change', async () => {
      if (collected.checked && o.payment_status !== 'confirmed') {
        const sure = window.confirm(`${name}\n\nPayment is NOT confirmed in QQ's bank yet (${paymentLabel(o.payment_status)}).\nA screenshot is not proof of payment.\n\nHand over anyway?`);
        if (!sure) { collected.checked = false; return; }
      }
      // The database records the real time; the value sent only means "yes"
      await save({ collected_at: collected.checked ? new Date().toISOString() : null },
        collected.checked ? `${name} marked collected.` : `${name} marked NOT collected.`);
    });

    // Cancel: if money may already have been paid, say so before cancelling
    const cancel = el('button', { type: 'button', className: 'small secondary', textContent: 'Cancel order' });
    confirmTap(cancel, 'Cancel order', async () => {
      if (o.payment_status !== 'unpaid') {
        const sure = window.confirm(`${name}\n\nThis order has a payment recorded (${paymentLabel(o.payment_status)}).\nQQ will need to check her bank and refund the customer.\n\nCancel anyway?`);
        if (!sure) return;
      }
      await save({ status: 'cancelled' }, o.payment_status === 'unpaid' ? `${name} cancelled.` : `${name} cancelled. Payment recorded: QQ to check and refund.`);
    });

    return [
      payment,
      el('div', { className: 'row order-actions' },
        el('label', { className: 'switch' }, collected, 'Collected'),
        cancel),
      auditLine(o),
    ];
  }


  /** "Screenshot: Ming 2026-10-11T20:22:10+08:00 · Confirmed: QQ 2026-10-11T21:00:42+08:00 · …" */
  function auditLine(o) {
    // In the order things happened. Steps converted from before 11 Oct 2026 have no time: listed first.
    const steps = [
      ['Screenshot', o.screenshot_by, o.screenshot_at],
      ['Confirmed', o.confirmed_by, o.confirmed_at],
      ['Collected', o.collected_by, o.collected_at],
      ['Cancelled', o.cancelled_by, o.cancelled_at],
      ['Refunded', o.refunded_by, o.refunded_at],
    ].filter(([, who]) => who)
      .sort((a, b) => (a[2] ? new Date(a[2]).getTime() : 0) - (b[2] ? new Date(b[2]).getTime() : 0));
    const parts = steps.map(([label, who, at]) => `${label}: ${shortWho(who)} ${when(at)}`.trim());
    return parts.length ? el('div', { className: 'hint audit', textContent: parts.join(' · ') }) : '';
  }


  // Screenshots waiting for QQ to confirm, across ALL dates, oldest first. In the
  // court case it took an audit years later to notice; this keeps it in view.
  async function loadUnconfirmed() {
    const days = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400e3);
    const age = (iso, fallback) => {
      // Orders converted by migration 005 have no screenshot time: don't count from 1970
      if (!iso) return fallback;
      const n = days(iso);
      return n === 0 ? 'since today' : plural(n, 'day');
    };
    const dateOf = (id) => dates.find((d) => d.id === id)?.delivery_date || '';
    const fill = (box, rows, title, hint, line) => {
      if (!rows?.length) { box.hidden = true; box.replaceChildren(); return; }
      box.hidden = false;
      box.replaceChildren(el('b', { textContent: title(rows) }), el('div', { className: 'hint', textContent: hint }),
        el('ul', {}, ...rows.map((o) => el('li', { textContent: line(o) }))));
    };
    const total = (rows) => money(rows.reduce((s, o) => s + o.total_cents, 0));
    const cols = 'id, order_ref, customer_name, total_cents, status, screenshot_at, cancelled_at, delivery_date_id';

    // 1. Screenshots not yet confirmed: active AND cancelled (a cancelled one may still need a refund)
    const shots = await sb.from('orders').select(cols).eq('payment_status', 'screenshot').order('screenshot_at');
    fill($('unconfirmed'), shots.error ? [] : shots.data,
      (rows) => `⚠ ${plural(rows.length, 'screenshot')} not yet confirmed in bank (${total(rows)})`,
      me.can_confirm_payments
        ? 'Check each one in your bank app (look for the order reference), then set it to Confirmed in bank, or Not paid if nothing arrived.'
        : 'QQ needs to check these in her bank app before they count as paid.',
      (o) => `${o.order_ref} · ${o.customer_name} · ${money(o.total_cents)} · for ${dateOf(o.delivery_date_id)} · waiting ${age(o.screenshot_at, 'since before 11 Oct 2026')}`
        + (o.status === 'cancelled' ? ' · CANCELLED: refund if the money arrived' : ''));

    // 2. Refunds to make: cancelled after the money was confirmed in the bank
    const refunds = await sb.from('orders').select(cols).eq('status', 'cancelled').eq('payment_status', 'confirmed').order('cancelled_at');
    fill($('refunds'), refunds.error ? [] : refunds.data,
      (rows) => `✗ ${plural(rows.length, 'refund')} to make (${total(rows)})`,
      me.can_confirm_payments
        ? 'These orders were cancelled after payment. Refund each customer by PayNow, then set the order to Refunded.'
        : 'These orders were cancelled after payment. QQ needs to refund them.',
      (o) => {
        const n = o.cancelled_at ? days(o.cancelled_at) : null;
        const ago = n === null ? 'cancelled before 11 Oct 2026' : n === 0 ? 'cancelled today' : `cancelled ${plural(n, 'day')} ago`;
        return `${o.order_ref} · ${o.customer_name} · ${money(o.total_cents)} · for ${dateOf(o.delivery_date_id)} · ${ago}`;
      });
  }


  // CSV export for spreadsheets / record keeping
  $('export').addEventListener('click', () => {
    const date = dates.find((d) => d.id === Number($('order-date').value));
    const header = ['order_ref', 'date', 'name', 'phone', 'fulfilment', 'address', 'items', 'total', 'status', 'payment',
      'screenshot_by', 'screenshot_at', 'confirmed_by', 'confirmed_at', 'refunded_by', 'refunded_at', 'collected_by', 'collected_at',
      'cancelled_by', 'cancelled_at', 'notes', 'created_at'];
    const quote = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = currentOrders.map((o) => [
      o.order_ref, date?.delivery_date, o.customer_name, o.phone, o.fulfilment, o.address,
      o.items.map((i) => `${i.product_name} ${itemSize(i.size_ml, i.container)} x${i.qty}`).join('; '),
      (o.total_cents / 100).toFixed(2), o.status, paymentLabel(o.payment_status),
      // Timestamps in Singapore time with offset, like the admin page shows them
      o.screenshot_by, isoSgt(o.screenshot_at), o.confirmed_by, isoSgt(o.confirmed_at), o.refunded_by, isoSgt(o.refunded_at),
      o.collected_by, isoSgt(o.collected_at), o.cancelled_by, isoSgt(o.cancelled_at), o.notes, isoSgt(o.created_at),
    ].map(quote).join(','));
    const blob = new Blob(['﻿' + [header.join(','), ...rows].join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `mincho-orders-${date?.delivery_date || 'all'}.csv` });
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // ---------------------------------------------------------------------------
  // Dates tab
  // ---------------------------------------------------------------------------
  // "Sat 31 Oct 2026" for a YYYY-MM-DD date
  const dateName = (iso) => longSgt(new Date(`${iso}T00:00:00+08:00`)).split(',')[0];

  $('date-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('date-msg');
    const date = $('new-date').value;     // YYYY-MM-DD from the date picker
    if (!date) { say(msg, 'FAILED TO ADD. Pick a date first.', 'bad', $('new-date')); return; }
    if (date < todaySgt()) { say(msg, `FAILED TO ADD. ${dateName(date)} is in the past.`, 'bad', $('new-date')); return; }
    const existing = dates.find((d) => d.delivery_date === date);
    if (existing) {
      say(msg, existing.active
        ? `FAILED TO ADD. ${dateName(date)} is already in the list.`
        : `FAILED TO ADD. ${dateName(date)} is already in the list, but not active. Tick its Active box instead.`, 'bad', $('new-date'));
      flashItem($('dates-table').querySelector(`tr[data-date="${date}"]`)); // point at the existing one
      return;
    }
    const { error } = await sb.from('delivery_dates').insert({ delivery_date: date, note: $('new-date-note').value.trim() });
    if (error) { say(msg, error.code === '23505' ? `FAILED TO ADD. ${dateName(date)} is already in the list.` : `FAILED TO ADD. ${report(error)}`, 'bad', $('new-date')); return; }
    $('new-date').value = '';
    $('new-date-note').value = '';
    await loadAll();
    const cut = cutoffFor(date);
    say(msg, Date.now() <= cut.getTime()
      ? `Added ${dateName(date)}. Orders close ${longSgt(cut)}.`
      : `Added ${dateName(date)}, but its order cutoff (${longSgt(cut)}) has already passed, so customers can't order for it. Shorten the cutoff in Settings if you need to.`,
      Date.now() <= cut.getTime() ? 'ok' : 'warn');
  });

  function renderDates() {
    const table = $('dates-table');
    const msg = $('date-msg');
    const head = el('thead', {}, el('tr', {}, ...['Date', 'Orders close', 'Note', 'Active', ''].map((h) => el('th', { textContent: h }))));
    const body = el('tbody');
    for (const d of [...dates].reverse()) {
      const active = el('input', { type: 'checkbox', checked: d.active, ariaLabel: `Active ${d.delivery_date}` });
      active.addEventListener('change', async () => {
        const { error } = await sb.from('delivery_dates').update({ active: active.checked }).eq('id', d.id);
        if (error) { say(msg, `FAILED TO SAVE. ${report(error)}`, 'bad'); active.checked = d.active; return; }
        d.active = active.checked;
        renderDateSelect();
        renderShopStatus();
        say(msg, d.active ? `${dateName(d.delivery_date)} is active.` : `${dateName(d.delivery_date)} is no longer active: customers can't order for it.`, 'ok');
      });
      const del = el('button', { type: 'button', className: 'small secondary', textContent: 'Delete' });
      confirmTap(del, 'Delete', async () => {
        const { error } = await sb.from('delivery_dates').delete().eq('id', d.id);
        if (error) {
          // 23503 = foreign key violation: orders exist for this date, and the database refuses
          say(msg, error.code === '23503'
            ? `FAILED TO DELETE. ${dateName(d.delivery_date)} has orders, so it can't be deleted. Untick Active instead.`
            : `FAILED TO DELETE. ${report(error)}`, 'bad');
          return;
        }
        await loadAll();
        say(msg, `Deleted ${dateName(d.delivery_date)}.`, 'ok');
      });
      // Short forms for a phone-width table: "Sat 24 Oct" and "Fri 23 Oct, 11:59 pm" (year left out)
      const cut = cutoffFor(d.delivery_date);
      const noYear = (text) => text.replace(/ \d{4}(,|$)/, '$1');
      const row = el('tr', {},
        el('td', { className: 'nowrap', textContent: noYear(dateName(d.delivery_date)) + (d.delivery_date < todaySgt() ? ' (past)' : '') }),
        el('td', { className: Date.now() <= cut.getTime() ? '' : 'closed-cut', textContent: Date.now() <= cut.getTime() ? noYear(longSgt(cut)) : 'Closed' }),
        el('td', { textContent: d.note }),
        el('td', {}, active),
        el('td', {}, del));
      row.dataset.date = d.delivery_date;
      body.append(row);
    }
    table.replaceChildren(head, body);
  }

  // ---------------------------------------------------------------------------
  // Menu tab
  // ---------------------------------------------------------------------------
  function renderMenu() {
    const box = $('products');
    box.replaceChildren();
    for (const p of products) {
      const name = el('input', { type: 'text', value: p.name, maxLength: 60, ariaLabel: 'Name' });
      const desc = el('input', { type: 'text', value: p.description, maxLength: 120, ariaLabel: 'Description' });
      const price = el('input', { type: 'number', min: '0.5', step: '0.5', value: (p.price_per_litre_cents / 100).toFixed(2), ariaLabel: 'Price per litre' });
      const active = el('input', { type: 'checkbox', checked: p.active });
      const msg = el('span', { className: 'hint', role: 'status' });
      const save = el('button', { type: 'button', className: 'small', textContent: 'Save' });
      save.addEventListener('click', async () => {
        const cents = Math.round(Number(price.value) * 100);
        if (!Number.isFinite(cents) || cents <= 0) { say(msg, 'FAILED TO SAVE. Enter a price per litre above $0.', 'bad', price); return; }
        const update = { name: name.value.trim() || p.name, description: desc.value.trim(), price_per_litre_cents: cents, active: active.checked };
        const { error } = await sb.from('products').update(update).eq('id', p.id);
        if (error) { say(msg, `FAILED TO SAVE. ${report(error)}`, 'bad'); return; }
        Object.assign(p, update);
        renderShopStatus();
        say(msg, `Saved ${p.name}: ${money(cents)} per litre, ${p.active ? 'on the menu' : 'hidden from customers'}.`, 'ok');
      });
      box.append(el('div', { className: 'tile stack' },
        el('label', {}, 'Name', name),
        el('label', {}, 'Description', desc),
        el('label', {}, 'Price per litre ($)', price),
        el('label', { className: 'switch' }, active, 'On the menu'),
        el('div', { className: 'row' }, save, msg)));
    }

    const sizeBox = $('sizes');
    sizeBox.replaceChildren();
    for (const s of sizes) {
      const cb = el('input', { type: 'checkbox', checked: s.active });
      cb.addEventListener('change', async () => {
        const { error } = await sb.from('bottle_sizes').update({ active: cb.checked }).eq('ml', s.ml).eq('container', s.container);
        if (error) { say($('size-msg'), `FAILED TO SAVE. ${report(error)}`, 'bad'); cb.checked = s.active; return; }
        s.active = cb.checked;
        renderShopStatus();
        say($('size-msg'), s.active ? `${itemSize(s.ml, s.container)} is on sale.` : `${itemSize(s.ml, s.container)} is no longer offered to customers.`, 'ok');
      });
      const label = el('label', { className: 'switch' }, cb, itemSize(s.ml, s.container));
      label.dataset.size = `${s.ml}|${s.container}`;
      sizeBox.append(label);
    }
  }

  // Add a drink. It goes on the menu straight away, priced per litre like the
  // others (bottle prices are pro-rata). The internal id is made from the name.
  $('product-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('product-msg');
    const name = $('new-name').value.trim();
    const cents = Math.round(Number($('new-price').value) * 100);
    if (!name) { say(msg, 'FAILED TO ADD. Enter a name.', 'bad', $('new-name')); return; }
    if (!Number.isFinite(cents) || cents <= 0) { say(msg, 'FAILED TO ADD. Enter a price per litre above $0.', 'bad', $('new-price')); return; }
    if (products.some((p) => p.name.toLowerCase() === name.toLowerCase())) { say(msg, `FAILED TO ADD. ${name} is already a drink.`, 'bad', $('new-name')); return; }
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'drink';
    const id = products.some((p) => p.id === slug) ? `${slug}_${Date.now().toString(36)}` : slug;
    const sortOrder = Math.max(0, ...products.map((p) => p.sort_order || 0)) + 1;
    const { error } = await sb.from('products').insert({
      id, name, description: $('new-desc').value.trim(), price_per_litre_cents: cents, active: true, sort_order: sortOrder,
    });
    if (error) { say(msg, `FAILED TO ADD. ${report(error)}`, 'bad'); return; }
    say(msg, `Added ${name} at ${money(cents)} per litre. It's on the menu now; untick "On the menu" to hide it.`, 'ok');
    e.target.reset();
    const r = await sb.from('products').select('*').order('sort_order');
    if (!r.error) { products = r.data; renderMenu(); renderOrders(); renderShopStatus(); }
  });

  // Add a size (packet or bottle). Its price is worked out automatically from each
  // drink's price per litre (pro-rata), so no price needs entering here.
  $('size-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('size-msg');
    const ml = Number($('new-size').value);
    if (!Number.isInteger(ml) || ml < 50 || ml > 5000) { say(msg, 'FAILED TO ADD. Enter a whole number of ml between 50 and 5000 (1 L = 1000).', 'bad', $('new-size')); return; }
    const container = $('new-size-container').value === 'packet' ? 'packet' : 'bottle';
    // A size is volume + container: 500 ml packet and 500 ml bottle can both exist.
    const existing = sizes.find((s) => s.ml === ml && s.container === container);
    if (existing) {
      say(msg, existing.active
        ? `FAILED TO ADD. ${itemSize(ml, container)} is already a size.`
        : `FAILED TO ADD. ${itemSize(ml, container)} is already a size, but unticked. Tick it above to offer it again.`, 'bad',
        [$('new-size'), $('new-size-container')]);
      flashItem($('sizes').querySelector(`[data-size="${ml}|${container}"]`)); // point at the existing one
      return;
    }
    const { error } = await sb.from('bottle_sizes').insert({ ml, container, active: true });
    if (error) { say(msg, error.code === '23505' ? `FAILED TO ADD. ${itemSize(ml, container)} is already a size.` : `FAILED TO ADD. ${report(error)}`, 'bad'); return; }
    const examples = products.filter((p) => p.active).map((p) => `${p.name.replace('Hong Kong ', '')} ${money(Math.round(p.price_per_litre_cents * ml / 1000))}`).join(' | ');
    say(msg, `Added ${itemSize(ml, container)}. Prices: ${examples}`, 'ok');
    $('new-size').value = '';
    const z = await sb.from('bottle_sizes').select('*').order('ml').order('container');
    if (!z.error) { sizes = z.data; renderMenu(); renderShopStatus(); }
  });

  // ---------------------------------------------------------------------------
  // Settings tab
  // ---------------------------------------------------------------------------
  function renderSettings() {
    $('s-open').checked = settings.ordering_open;
    $('s-delivery').checked = settings.delivery_enabled;
    $('s-fee').value = (settings.delivery_fee_cents / 100).toFixed(2);
    $('s-free').value = ((settings.free_delivery_min_cents || 0) / 100).toFixed(2);
    $('s-min').value = (settings.min_order_cents / 100).toFixed(2);
    $('s-cutoff-days').value = settings.cutoff_days;
    $('s-cutoff-time').value = String(settings.cutoff_time).slice(0, 5);
    $('s-paynow').value = settings.paynow_number;
    $('s-note').value = settings.collection_note;
    $('s-retention').value = settings.retention_days;
    $('invite-code').textContent = settings.invite_code;
    $('invite-link').textContent = `${location.origin}/?code=${encodeURIComponent(settings.invite_code)}`;
  }

  // Two-tap guard for Save: armedFor remembers which change was warned about,
  // so a second tap only confirms that same change (editing a field re-warns).
  let armedFor = '';
  let armedTimer;
  const SAVE_LABEL = $('save-settings').textContent;
  const dayLabel = (iso) => formatSgt(new Date(`${iso}T12:00:00+08:00`), { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');

  $('save-settings').addEventListener('click', async () => {
    const msg = $('settings-msg');
    const btn = $('save-settings');
    const toCents = (v) => Math.max(0, Math.round(Number(v || 0) * 100));
    const paynow = $('s-paynow').value.replace(/\s/g, '');
    if (!/^[89]\d{7}$/.test(paynow)) { say(msg, 'FAILED TO SAVE. PayNow number must be an 8-digit Singapore mobile number (starts with 8 or 9).', 'bad', $('s-paynow')); return; }
    const update = {
      ordering_open: $('s-open').checked,
      delivery_enabled: $('s-delivery').checked,
      delivery_fee_cents: toCents($('s-fee').value),
      free_delivery_min_cents: toCents($('s-free').value),
      min_order_cents: toCents($('s-min').value),
      cutoff_days: Math.min(14, Math.max(0, parseInt($('s-cutoff-days').value || '1', 10))),
      cutoff_time: $('s-cutoff-time').value || '23:59',
      paynow_number: paynow,
      collection_note: $('s-note').value.trim(),
      retention_days: Math.min(730, Math.max(7, parseInt($('s-retention').value || '90', 10))),
      updated_at: new Date().toISOString(),
    };
    // Dates that are open for orders now, but would be past their cutoff under the new rule
    const now = Date.now();
    const closing = dates.filter((d) => d.active
      && now <= cutoffFor(d.delivery_date).getTime()
      && now > cutoffFor(d.delivery_date, update).getTime());
    const key = closing.length ? `${update.cutoff_days}|${update.cutoff_time}|${closing.map((d) => d.id).join(',')}` : '';
    clearTimeout(armedTimer);
    btn.textContent = SAVE_LABEL;
    if (key && key !== armedFor) {
      armedFor = key;
      btn.textContent = 'Tap again to confirm';
      const names = closing.map((d) => dayLabel(d.delivery_date));
      const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
      say(msg, `This closes orders for ${list} now. Tap Save again to confirm.`, 'warn');
      // Not confirmed within 10 seconds: stand down, nothing saved
      armedTimer = setTimeout(() => { armedFor = ''; btn.textContent = SAVE_LABEL; say(msg, 'Not saved, so nothing changed for customers. Tap Save to try again.', 'warn'); }, 10000);
      return;
    }
    armedFor = '';
    say(msg, 'Saving…');

    const before = settings;
    const { data, error } = await sb.from('settings').update(update).eq('id', 1).select().single();
    if (error) { say(msg, `FAILED TO SAVE. ${report(error)}`, 'bad'); return; }
    settings = data;
    renderSettings();
    renderShopStatus();
    const lines = [`Saved. Shop is ${data.ordering_open ? 'OPEN' : 'CLOSED'}.`];
    // If the cutoff rule changed, spell out the new cutoff for each upcoming date,
    // so owners can check it, and see straight away if a date has just closed.
    if (before.cutoff_days !== data.cutoff_days || String(before.cutoff_time).slice(0, 5) !== String(data.cutoff_time).slice(0, 5)) {
      const n = data.cutoff_days;
      const when = n === 0 ? 'on the day' : `${n} day${n === 1 ? '' : 's'} before`;
      lines.push(`Order cutoff changed to ${when}:`);
      const upcoming = dates.filter((d) => d.active && d.delivery_date >= todaySgt());
      if (upcoming.length === 0) lines.push('• No upcoming active dates.');
      for (const d of upcoming) {
        const cut = cutoffFor(d.delivery_date);
        const date = formatSgt(new Date(`${d.delivery_date}T12:00:00+08:00`), { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
        lines.push(Date.now() > cut.getTime()
          ? `• ${date} collection: orders ALREADY CLOSED (cutoff was ${longSgt(cut)})`
          : `• ${date} collection: orders close ${longSgt(cut)}`);
      }
    }
    say(msg, lines.join('\n'), 'ok');
  });

  $('copy-code').addEventListener('click', (e) => copy(settings.invite_code, e.currentTarget));
  $('copy-link').addEventListener('click', (e) => copy($('invite-link').textContent, e.currentTarget));

  // New invite code: 8 characters from an alphabet without look-alikes,
  // using the browser's cryptographic random generator.
  confirmTap($('new-code'), 'Make a new code', async () => {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const code = 'TEA-' + [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
    const { data, error } = await sb.from('settings').update({ invite_code: code, updated_at: new Date().toISOString() }).eq('id', 1).select().single();
    if (error) return say($('settings-msg'), `FAILED TO MAKE NEW CODE. The old code still works. ${report(error)}`, 'bad');
    settings = data;
    renderSettings();
    say($('settings-msg'), 'New invite code made. The old code and link no longer work', 'ok');
  });

  confirmTap($('purge'), 'Delete orders older than this', async () => {
    const msg = $('purge-msg');
    // Save the retention period first so the purge uses what is on screen
    const days = Math.min(730, Math.max(7, parseInt($('s-retention').value || '90', 10)));
    const up = await sb.from('settings').update({ retention_days: days }).eq('id', 1);
    if (up.error) return say(msg, `FAILED. Nothing deleted. ${report(up.error)}`, 'bad');
    const { data, error } = await sb.rpc('purge_old_orders');
    if (error) return say(msg, `FAILED. Nothing deleted. ${report(error)}`, 'bad');
    say(msg, `Deleted ${data} order${data === 1 ? '' : 's'} older than ${days} days.`, 'ok');
    await loadOrders();
  });

  // ---------------------------------------------------------------------------
  // Owners (Settings tab)
  // ---------------------------------------------------------------------------
  async function loadOwners() {
    const table = $('owners-table');
    const { ok, data } = await ownerApi('GET');
    if (!ok) { table.replaceChildren(el('tbody', {}, el('tr', {}, el('td', { className: 'error', textContent: data.error || 'Could not load owners.' })))); return; }
    const head = el('thead', {}, el('tr', {}, ...['Email', 'Added', ''].map((h) => el('th', { textContent: h }))));
    const body = el('tbody');
    for (const o of data.owners) {
      const isMe = o.user_id === data.you;
      let action = el('span', { className: 'hint', textContent: isMe ? 'You' : '' });
      if (!isMe) {
        action = el('button', { type: 'button', className: 'small secondary', textContent: 'Remove' });
        confirmTap(action, 'Remove', async () => {
          const r = await ownerApi('DELETE', { userId: o.user_id });
          say($('owner-msg'), r.ok ? `Removed ${o.email}. Their login no longer works.` : `FAILED TO REMOVE. ${r.data.error || 'Please try again.'}`, r.ok ? 'ok' : 'bad');
          await loadOwners();
        });
      }
      body.append(el('tr', {},
        el('td', {}, o.display_name ? el('b', { textContent: o.display_name }) : '', o.display_name ? el('br') : '', o.email,
          o.can_confirm_payments ? el('div', { className: 'hint', textContent: '✓ Can confirm payments' }) : ''),
        el('td', { textContent: new Date(o.created_at).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' }) }),
        el('td', {}, action)));
    }
    table.replaceChildren(head, body);
  }

  $('owner-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('owner-msg');
    const name = $('owner-name').value.trim();
    const email = $('owner-email').value.trim();
    const password = $('owner-password').value;
    if (!name) { say(msg, 'FAILED TO ADD. Enter a name, e.g. QQ. It is shown on the orders they update.', 'bad', $('owner-name')); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { say(msg, 'FAILED TO ADD. Enter a valid email.', 'bad', $('owner-email')); return; }
    if (password.length < 10) { say(msg, 'FAILED TO ADD. The starting password needs at least 10 characters.', 'bad', $('owner-password')); return; }
    say(msg, 'Adding…');
    const r = await ownerApi('POST', { name, email, password });
    if (!r.ok) { say(msg, `FAILED TO ADD. ${r.data.error || 'Please try again.'}`, 'bad', /email/i.test(r.data.error || '') ? $('owner-email') : null); return; }
    e.target.reset();
    say(msg, `Added ${name} (${email}) as an owner. Send them the starting password privately.`, 'ok');
    await loadOwners();
  });

  // Each owner can replace the starting password they were given at handover.
  // Supabase changes the password for whoever is logged in on this device.
  $('password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('password-msg');
    const pw = $('new-password').value;
    if (pw.length < 10) { say(msg, 'FAILED TO CHANGE. Use at least 10 characters.', 'bad', $('new-password')); return; }
    if (pw !== $('new-password-2').value) { say(msg, 'FAILED TO CHANGE. The two passwords do not match.', 'bad', $('new-password-2')); return; }
    const { error } = await sb.auth.updateUser({ password: pw });
    if (error) { say(msg, `FAILED TO CHANGE. ${report(error)}`, 'bad'); return; }
    e.target.reset();
    say(msg, 'Password changed. Use the new one next time you log in.', 'ok');
  });

  init().catch((err) => {
    console.error(err);
    document.body.append(el('p', { className: 'wrap error', textContent: 'Could not start the admin page. Check the setup steps in the README.' }));
  });
})();
