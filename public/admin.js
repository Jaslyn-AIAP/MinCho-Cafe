// =============================================================================
// admin.js — owners' page (Ming Ming, QQ, Jaslyn)
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
  // "250 ml packet" / "1 L bottle". Old orders without a container fall back to the current size list.
  const itemSize = (ml, container) => `${sizeLabel(ml)} ${container || sizes?.find((s) => s.ml === ml)?.container || 'bottle'}`;
  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    for (const c of children) node.append(c);
    return node;
  };
  const todaySgt = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const STATUSES = [
    ['awaiting_payment', 'Awaiting payment'],
    ['paid', 'Paid'],
    ['collected', 'Collected'],
    ['cancelled', 'Cancelled'],
  ];

  let sb;                 // Supabase client
  let settings, products, sizes, dates = [];
  let currentOrders = [];

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  /** Show a Supabase error in a status element (or the console). */
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
    if (error) { box.textContent = 'Wrong email or password.'; box.hidden = false; return; }
    await enter(data.session);
  });

  $('logout').addEventListener('click', async () => {
    await sb.auth.signOut();
    location.reload();
  });

  async function enter(session) {
    // Confirm this login is actually an owner
    const { data: me } = await sb.from('admins').select('email').eq('user_id', session.user.id).maybeSingle();
    if (!me) {
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
      sb.from('bottle_sizes').select('*').order('ml'),
      sb.from('delivery_dates').select('*').order('delivery_date'),
    ]);
    for (const r of [s, p, z, d]) if (r.error) return report(r.error);
    settings = s.data; products = p.data; sizes = z.data; dates = d.data;
    renderDateSelect();
    renderDates();
    renderMenu();
    renderSettings();
    await loadOrders();
    await loadOwners();
  }

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
    select.value = previous || String((upcoming || dates[dates.length - 1] || {}).id || '');
  }
  $('order-date').addEventListener('change', loadOrders);
  $('refresh').addEventListener('click', loadOrders);

  async function loadOrders() {
    const dateId = Number($('order-date').value);
    if (!dateId) { currentOrders = []; renderOrders(); return; }
    const { data, error } = await sb.from('orders').select('*').eq('delivery_date_id', dateId).order('created_at');
    if (error) return report(error);
    currentOrders = data;
    renderOrders();
  }

  function renderOrders() {
    const live = currentOrders.filter((o) => o.status !== 'cancelled');

    // --- Brewing summary: litres per drink and bottles per size ---------------
    const brew = $('brew');
    brew.replaceChildren();
    for (const p of products) {
      let ml = 0;
      const bySize = new Map();
      for (const o of live) for (const i of o.items) if (i.product_id === p.id) {
        ml += i.size_ml * i.qty;
        bySize.set(i.size_ml, (bySize.get(i.size_ml) || 0) + i.qty);
      }
      // "250 ml packet × 9 | 500 ml bottle × 7 | 1 L bottle × 1" — each item kept on one line
      const parts = [...bySize.entries()].sort((a, b) => a[0] - b[0]).map(([s, n]) => el('span', { className: 'nowrap', textContent: `${itemSize(s)} × ${n}` }));
      const breakdown = parts.length ? parts.flatMap((part, i) => (i ? [' | ', part] : [part])) : ['None'];
      brew.append(el('div', { className: 'tile' },
        el('div', { className: 'hint', textContent: p.name }),
        el('div', { className: 'big', textContent: `${(ml / 1000).toFixed(2)} L` }),
        el('div', { className: 'hint' }, ...breakdown)));
    }
    const total = live.reduce((s, o) => s + o.total_cents, 0);
    const paid = live.filter((o) => o.status !== 'awaiting_payment').reduce((s, o) => s + o.total_cents, 0);
    brew.append(el('div', { className: 'tile' },
      el('div', { className: 'hint', textContent: `${live.length} orders` }),
      el('div', { className: 'big', textContent: money(total) }),
      el('div', { className: 'hint', textContent: `${money(paid)} paid, ${money(total - paid)} waiting` })));

    // --- Order table --------------------------------------------------------------
    const table = $('orders-table');
    const head = el('thead', {}, el('tr', {}, ...['Ref', 'Customer', 'Items', 'Total', 'Status'].map((h) => el('th', { textContent: h }))));
    const body = el('tbody');
    if (!currentOrders.length) body.append(el('tr', {}, el('td', { colSpan: 5, className: 'hint', textContent: 'No orders for this date yet.' })));
    for (const o of currentOrders) {
      const status = el('select', { ariaLabel: `Status for ${o.order_ref}` },
        ...STATUSES.map(([v, label]) => el('option', { value: v, textContent: label, selected: o.status === v })));
      status.addEventListener('change', async () => {
        const { error } = await sb.from('orders').update({ status: status.value }).eq('id', o.id);
        if (error) { report(error); status.value = o.status; return; }
        o.status = status.value;
        renderOrders();
      });
      const items = o.items.map((i) => `${i.product_name.replace('Hong Kong ', '')} ${itemSize(i.size_ml, i.container)} × ${i.qty}`).join('\n');
      body.append(el('tr', {},
        el('td', {}, el('strong', { textContent: o.order_ref }), el('br'), el('span', { className: 'pill ' + o.status, textContent: STATUSES.find(([v]) => v === o.status)[1] })),
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
        el('td', {}, status)));
    }
    table.replaceChildren(head, body);
  }

  // CSV export for spreadsheets / record keeping
  $('export').addEventListener('click', () => {
    const date = dates.find((d) => d.id === Number($('order-date').value));
    const header = ['order_ref', 'date', 'name', 'phone', 'fulfilment', 'address', 'items', 'total', 'status', 'notes', 'created_at'];
    const quote = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = currentOrders.map((o) => [
      o.order_ref, date?.delivery_date, o.customer_name, o.phone, o.fulfilment, o.address,
      o.items.map((i) => `${i.product_name} ${itemSize(i.size_ml, i.container)} x${i.qty}`).join('; '),
      (o.total_cents / 100).toFixed(2), o.status, o.notes, o.created_at,
    ].map(quote).join(','));
    const blob = new Blob(['﻿' + [header.join(','), ...rows].join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `mincho-orders-${date?.delivery_date || 'all'}.csv` });
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // ---------------------------------------------------------------------------
  // Dates tab
  // ---------------------------------------------------------------------------
  $('date-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const date = $('new-date').value;
    if (!date) return;
    const { error } = await sb.from('delivery_dates').insert({ delivery_date: date, note: $('new-date-note').value.trim() });
    if (error) { alertInline($('dates-table'), error.code === '23505' ? 'That date already exists.' : report(error)); return; }
    $('new-date').value = '';
    $('new-date-note').value = '';
    await loadAll();
  });

  function alertInline(near, msg) {
    const p = el('p', { className: 'error', textContent: msg });
    near.before(p);
    setTimeout(() => p.remove(), 5000);
  }

  function renderDates() {
    const table = $('dates-table');
    const head = el('thead', {}, el('tr', {}, ...['Date', 'Note', 'Active', ''].map((h) => el('th', { textContent: h }))));
    const body = el('tbody');
    for (const d of [...dates].reverse()) {
      const active = el('input', { type: 'checkbox', checked: d.active, ariaLabel: `Active ${d.delivery_date}` });
      active.addEventListener('change', async () => {
        const { error } = await sb.from('delivery_dates').update({ active: active.checked }).eq('id', d.id);
        if (error) { report(error); active.checked = d.active; return; }
        d.active = active.checked;
        renderDateSelect();
      });
      const del = el('button', { type: 'button', className: 'small secondary', textContent: 'Delete' });
      confirmTap(del, 'Delete', async () => {
        const { error } = await sb.from('delivery_dates').delete().eq('id', d.id);
        if (error) {
          // 23503 = foreign key violation: orders exist for this date
          alertInline(table, error.code === '23503' ? 'This date has orders. Untick "Active" instead of deleting it.' : report(error));
          return;
        }
        await loadAll();
      });
      body.append(el('tr', {},
        el('td', { textContent: d.delivery_date + (d.delivery_date < todaySgt() ? ' (past)' : '') }),
        el('td', { textContent: d.note }),
        el('td', {}, active),
        el('td', {}, del)));
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
        if (!Number.isFinite(cents) || cents <= 0) { msg.textContent = 'Enter a price above $0.'; return; }
        const { error } = await sb.from('products')
          .update({ name: name.value.trim() || p.name, description: desc.value.trim(), price_per_litre_cents: cents, active: active.checked })
          .eq('id', p.id);
        msg.textContent = error ? `Error: ${report(error)}` : 'Saved';
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
        const { error } = await sb.from('bottle_sizes').update({ active: cb.checked }).eq('ml', s.ml);
        if (error) { report(error); cb.checked = s.active; }
      });
      sizeBox.append(el('label', { className: 'switch' }, cb, itemSize(s.ml, s.container)));
    }
  }

  // Add a drink. It goes on the menu straight away, priced per litre like the
  // others (bottle prices are pro-rata). The internal id is made from the name.
  $('product-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('product-msg');
    const name = $('new-name').value.trim();
    const cents = Math.round(Number($('new-price').value) * 100);
    if (!name) { msg.textContent = 'Enter a name.'; return; }
    if (!Number.isFinite(cents) || cents <= 0) { msg.textContent = 'Enter a price per litre above $0.'; return; }
    if (products.some((p) => p.name.toLowerCase() === name.toLowerCase())) { msg.textContent = 'A drink with that name already exists.'; return; }
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'drink';
    const id = products.some((p) => p.id === slug) ? `${slug}_${Date.now().toString(36)}` : slug;
    const sortOrder = Math.max(0, ...products.map((p) => p.sort_order || 0)) + 1;
    const { error } = await sb.from('products').insert({
      id, name, description: $('new-desc').value.trim(), price_per_litre_cents: cents, active: true, sort_order: sortOrder,
    });
    if (error) { msg.textContent = `Error: ${report(error)}`; return; }
    msg.textContent = `Added ${name}. It's on the menu now; untick "On the menu" to hide it.`;
    e.target.reset();
    const r = await sb.from('products').select('*').order('sort_order');
    if (!r.error) { products = r.data; renderMenu(); renderOrders(); }
  });

  // Add a size (packet or bottle). Its price is worked out automatically from each
  // drink's price per litre (pro-rata), so no price needs entering here.
  $('size-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('size-msg');
    const ml = Number($('new-size').value);
    if (!Number.isInteger(ml) || ml < 50 || ml > 5000) { msg.textContent = 'Enter a whole number of ml between 50 and 5000.'; return; }
    const container = $('new-size-container').value === 'packet' ? 'packet' : 'bottle';
    const { error } = await sb.from('bottle_sizes').insert({ ml, container, active: true });
    if (error) { msg.textContent = error.code === '23505' ? `${sizeLabel(ml)} already exists. Tick it above to show it.` : `Error: ${report(error)}`; return; }
    const examples = products.filter((p) => p.active).map((p) => `${p.name.replace('Hong Kong ', '')} ${money(Math.round(p.price_per_litre_cents * ml / 1000))}`).join(' | ');
    msg.textContent = `Added ${itemSize(ml, container)}. Prices: ${examples}`;
    $('new-size').value = '';
    const z = await sb.from('bottle_sizes').select('*').order('ml');
    if (!z.error) { sizes = z.data; renderMenu(); }
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

  $('save-settings').addEventListener('click', async () => {
    const msg = $('settings-msg');
    const toCents = (v) => Math.max(0, Math.round(Number(v || 0) * 100));
    const paynow = $('s-paynow').value.replace(/\s/g, '');
    if (!/^[89]\d{7}$/.test(paynow)) { msg.textContent = 'PayNow number must be an 8-digit Singapore mobile number (starts with 8 or 9).'; return; }
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
    const { data, error } = await sb.from('settings').update(update).eq('id', 1).select().single();
    if (error) { report(error, msg); return; }
    settings = data;
    renderSettings();
    msg.textContent = 'Saved';
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
    if (error) return report(error, $('settings-msg'));
    settings = data;
    renderSettings();
  });

  confirmTap($('purge'), 'Delete orders older than this', async () => {
    const msg = $('purge-msg');
    // Save the retention period first so the purge uses what is on screen
    const days = Math.min(730, Math.max(7, parseInt($('s-retention').value || '90', 10)));
    const up = await sb.from('settings').update({ retention_days: days }).eq('id', 1);
    if (up.error) return report(up.error, msg);
    const { data, error } = await sb.rpc('purge_old_orders');
    if (error) return report(error, msg);
    msg.textContent = `Deleted ${data} old order${data === 1 ? '' : 's'}.`;
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
          $('owner-msg').textContent = r.ok ? `Removed ${o.email}.` : r.data.error || 'Could not remove.';
          await loadOwners();
        });
      }
      body.append(el('tr', {},
        el('td', { textContent: o.email }),
        el('td', { textContent: new Date(o.created_at).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' }) }),
        el('td', {}, action)));
    }
    table.replaceChildren(head, body);
  }

  $('owner-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('owner-msg');
    const email = $('owner-email').value.trim();
    const password = $('owner-password').value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg.textContent = 'Enter a valid email.'; return; }
    if (password.length < 10) { msg.textContent = 'Starting password needs at least 10 characters.'; return; }
    msg.textContent = 'Adding…';
    const r = await ownerApi('POST', { email, password });
    if (!r.ok) { msg.textContent = r.data.error || 'Could not add the owner.'; return; }
    e.target.reset();
    msg.textContent = `Added ${email}. Send them the starting password privately.`;
    await loadOwners();
  });

  // Each owner can replace the starting password they were given at handover.
  // Supabase changes the password for whoever is logged in on this device.
  $('password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('password-msg');
    const pw = $('new-password').value;
    if (pw.length < 10) { msg.textContent = 'Use at least 10 characters.'; return; }
    if (pw !== $('new-password-2').value) { msg.textContent = 'The two passwords do not match.'; return; }
    const { error } = await sb.auth.updateUser({ password: pw });
    if (error) { msg.textContent = `Error: ${report(error)}`; return; }
    e.target.reset();
    msg.textContent = 'Password changed. Use the new one next time you log in.';
  });

  init().catch((err) => {
    console.error(err);
    document.body.append(el('p', { className: 'wrap error', textContent: 'Could not start the admin page. Check the setup steps in the README.' }));
  });
})();
