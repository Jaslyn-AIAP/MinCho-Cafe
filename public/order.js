// =============================================================================
// order.js — customer order page
// -----------------------------------------------------------------------------
// Flow: invite code → menu + form → server places order → PayNow instructions.
// Prices shown here are for display only; the server recalculates everything.
// All text from the server is inserted with textContent (never innerHTML) so
// nothing in the database can inject script into the page.
// =============================================================================
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const money = (cents) => `$${(cents / 100).toFixed(2)}`;
  const sizeLabel = (ml) => (ml >= 1000 ? `${ml / 1000} L` : `${ml} ml`);
  // What each size comes in ("packet" or "bottle"), from the menu or the order item
  const containerFor = (ml, item) => item?.container || menu?.containers?.[ml] || 'bottle';
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    for (const c of children) node.append(c);
    return node;
  };
  const DEMO = Boolean(window.MINCHO_DEMO);

  // ---------------------------------------------------------------------------
  // API layer. In demo mode (the preview published for the owners to try) the
  // calls are answered by window.MINCHO_DEMO instead of the real server.
  // ---------------------------------------------------------------------------
  async function post(path, body) {
    if (DEMO) return window.MINCHO_DEMO.handle(path, body);
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({ error: 'Unexpected response from server.' }));
    return { ok: res.ok, status: res.status, data };
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let menu = null;          // response from /api/menu
  let code = '';
  const qty = new Map();    // key "product|ml" → number
  let turnstileToken = '';
  let turnstileWidget = null;

  // Why the shop can't take orders right now, or '' if it can.
  //   'paused'   — the owners unticked "Shop open"
  //   'no-dates' — open, but no collection date is before its cutoff
  //                (e.g. the last round closed and the next date isn't added yet)
  const closedReason = (m) => (!m.orderingOpen ? 'paused' : m.dates.length === 0 ? 'no-dates' : '');
  // Wording for the shop-closed page, per reason. The sign changes too:
  // 'paused' is the "Shop closed" sign, 'no-dates' the "Orders paused" sign
  // (tilted the other way and with a small-caps subtitle; see styles.css).
  const CLOSED_TEXT = {
    'paused': {
      eyebrow: 'Order window', eyebrowZh: '暫停營業',
      zh: '今日休息', title: 'Shop closed', sub: 'Our kettles are resting for now.',
      head: 'We’ll be pouring again soon.',
      body: 'Ming Ming and QQ are taking a breather between brews. We’ll post in the WhatsApp group when orders open again.',
    },
    'no-dates': {
      eyebrow: 'Order status', eyebrowZh: '今期截單',
      zh: '今期截單', title: 'Orders paused', sub: 'Shop open · Next dates soon',
      head: 'This order window has closed.',
      body: 'All current brew dates are past their order cut-off. Ming Ming and QQ are catching their breath—we’ll post in the WhatsApp group when the next window opens.',
    },
  };

  function setClosedWording(why) {
    const text = CLOSED_TEXT[why];
    $('closed').dataset.reason = why; // styles.css switches the sign's tilt and subtitle style on this
    for (const [id, key] of [['closed-eyebrow', 'eyebrow'], ['closed-eyebrow-zh', 'eyebrowZh'], ['closed-zh', 'zh'],
      ['closed-title', 'title'], ['closed-sub', 'sub'], ['closed-head', 'head'], ['closed-text', 'body']]) {
      $(id).textContent = text[key];
    }
  }

  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  // ---------------------------------------------------------------------------
  // Step 1: invite code (from ?code=… link, remembered code, or typed)
  // ---------------------------------------------------------------------------
  const params = new URLSearchParams(location.search);
  const linkCode = params.get('code');
  $('code').value = linkCode || storage.get('mincho_code') || '';
  if (linkCode) history.replaceState(null, '', location.pathname); // keep the code out of the address bar

  $('gate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const typed = $('code').value.trim();
    const errorBox = $('gate-error');
    errorBox.hidden = true;
    if (!typed) { errorBox.textContent = 'Please enter the invite code.'; errorBox.hidden = false; return; }

    const btn = e.submitter || $('gate-form').querySelector('button');
    btn.disabled = true;
    const { ok, data } = await post('/api/menu', { code: typed }).catch(() => ({ ok: false, data: { error: 'Network problem. Please try again.' } }));
    btn.disabled = false;

    if (!ok) {
      storage.del('mincho_code');
      errorBox.textContent = data.error || 'Could not load the menu.';
      errorBox.hidden = false;
      return;
    }
    code = typed;
    storage.set('mincho_code', typed);
    menu = data;
    renderOrderForm();
  });

  // Auto-continue if a code came from the link or memory
  if ($('code').value) $('gate-form').requestSubmit();

  // ---------------------------------------------------------------------------
  // Step 2: order form
  // ---------------------------------------------------------------------------
  function renderOrderForm() {
    $('gate').hidden = true;
    $('order-form').hidden = false;

    // Nothing can be ordered right now: show the shop-closed sign instead of a
    // menu. Two reasons, same sign, different wording. (The server refuses
    // orders in both cases anyway.)
    const why = closedReason(menu);
    $('closed').hidden = !why;
    if (why) {
      setClosedWording(why);
      $('closed-msg').hidden = true;
      $('order-form').hidden = true;
      window.scrollTo({ top: 0 });
      return;
    }

    // Dates: radio cards with a vermilion date block ("17 / OCT")
    const dates = $('dates');
    dates.replaceChildren();
    menu.dates.forEach((d, i) => {
      const at = new Date(`${d.date}T00:00:00+08:00`);
      const fmt = (opts) => at.toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore', ...opts });
      dates.append(el('label', { className: 'choice' },
        el('input', { type: 'radio', name: 'date', value: String(d.id), checked: i === 0 }),
        el('span', { className: 'choice-face' },
          el('span', { className: 'radio' }),
          el('span', { className: 'datebox' }, el('b', { textContent: fmt({ day: 'numeric' }) }), el('span', { textContent: fmt({ month: 'short' }) })),
          el('span', { className: 'choice-text' },
            el('strong', { textContent: fmt({ weekday: 'short', day: 'numeric', month: 'short' }) }),
            el('small', { textContent: `Order by ${d.closes}` }),
            d.note ? el('small', { textContent: d.note }) : '')),
      ));
    });

    // Menu board. Chinese names are fixed labels for the two current drinks;
    // a new product added in admin simply shows without one.
    const ZH = { milk_tea: '港式奶茶', lemon_tea: '港式檸茶' };
    const board = $('menu');
    board.replaceChildren();
    for (const p of menu.products) {
      const rows = [];
      for (const ml of menu.sizes) {
        const key = `${p.id}|${ml}`;
        const out = el('output', { textContent: String(qty.get(key) || 0), id: `q-${p.id}-${ml}` });
        const change = (delta) => {
          const next = Math.max(0, Math.min(50, (qty.get(key) || 0) + delta));
          qty.set(key, next);
          out.textContent = String(next);
          updateTotal();
        };
        rows.push(el('div', { className: 'size-row' },
          el('span', { className: 'size-name' }, el('b', { textContent: sizeLabel(ml) }), el('small', { textContent: containerFor(ml) })),
          el('span', { className: 'price', textContent: money(p.bottlePrices[ml]) }),
          el('span', { className: 'stepper' },
            el('button', { type: 'button', textContent: '−', ariaLabel: `Fewer ${p.name} ${sizeLabel(ml)} ${containerFor(ml)}`, onclick: () => change(-1) }),
            out,
            el('button', { type: 'button', textContent: '+', ariaLabel: `More ${p.name} ${sizeLabel(ml)} ${containerFor(ml)}`, onclick: () => change(1) })),
        ));
      }
      board.append(el('div', { className: 'drink' },
        el('div', { className: 'drink-head' },
          el('div', {},
            ZH[p.id] ? el('span', { className: 'drink-zh', lang: 'zh-Hant', textContent: ZH[p.id] }) : '',
            el('span', { className: `drink-name ${p.id}`, textContent: p.name }),
            p.description ? el('p', { className: 'hint', textContent: p.description }) : ''),
          el('span', { className: 'per-litre' }, el('small', { textContent: 'per litre' }), el('b', { textContent: money(p.pricePerLitreCents) }))),
        ...rows));
    }

    // Collection / delivery cards
    const choiceCard = (value, title, note, price, checked) => el('label', { className: 'choice' },
      el('input', { type: 'radio', name: 'fulfilment', value, checked }),
      el('span', { className: 'choice-face' },
        el('span', { className: 'radio' }),
        el('span', { className: 'choice-text' }, el('strong', { textContent: title }), note ? el('small', { textContent: note }) : ''),
        el('span', { className: 'choice-price', textContent: price })));
    const ful = $('fulfilment');
    ful.replaceChildren(choiceCard('collection', 'Self-collect', menu.collectionNote, 'Free', true));
    if (menu.deliveryEnabled) {
      ful.append(choiceCard('delivery', 'Delivery', 'Enter your address below.',
        !menu.deliveryFeeCents ? 'Free' : menu.freeDeliveryMinCents ? `${money(menu.deliveryFeeCents)}, free from ${money(menu.freeDeliveryMinCents)}` : money(menu.deliveryFeeCents), false));
    }
    ful.onchange = onFulfilmentChange;
    onFulfilmentChange();

    // Remember name/phone on this device for next week (convenience only)
    $('name').value = storage.get('mincho_name') || '';
    $('phone').value = storage.get('mincho_phone') || '';

    loadTurnstile();
    updateTotal();
  }

  function fulfilment() {
    return document.querySelector('input[name="fulfilment"]:checked')?.value || 'collection';
  }

  function onFulfilmentChange() {
    const delivery = fulfilment() === 'delivery';
    $('address-wrap').hidden = !delivery;
    updateTotal();
  }

  function cartItems() {
    return [...qty.entries()]
      .filter(([, n]) => n > 0)
      .map(([key, n]) => {
        const [product_id, ml] = key.split('|');
        return { product_id, size_ml: Number(ml), qty: n };
      });
  }

  function updateTotal() {
    let subtotal = 0;
    let bottles = 0;
    const counts = {};  // { packet: 5, bottle: 5 }
    for (const item of cartItems()) {
      const p = menu.products.find((x) => x.id === item.product_id);
      subtotal += p.bottlePrices[item.size_ml] * item.qty;
      bottles += item.qty;
      const c = containerFor(item.size_ml);
      counts[c] = (counts[c] || 0) + item.qty;
    }
    // Mirrors lib/rules.js deliveryFeeCents(); the server has the final say.
    const freeFrom = menu.freeDeliveryMinCents || 0;
    const delivering = fulfilment() === 'delivery';
    const fee = !delivering || (freeFrom > 0 && subtotal >= freeFrom) ? 0 : menu.deliveryFeeCents;
    $('total').textContent = money(subtotal + fee);

    const belowMin = subtotal > 0 && subtotal < menu.minOrderCents;
    const nudge = delivering && fee && freeFrom > 0 ? ` · ${money(freeFrom - subtotal)} more for free delivery` : '';
    const freeNote = delivering && !fee && freeFrom > 0 && menu.deliveryFeeCents ? ' incl. free delivery' : '';
    $('total-sub').textContent = bottles === 0
      ? 'Nothing added yet'
      : belowMin
        ? `Minimum order ${money(menu.minOrderCents)}`
        : `${['packet', 'bottle'].filter((c) => counts[c]).map((c) => plural(counts[c], c)).join(' · ')}${fee ? ` incl. ${money(fee)} delivery` : freeNote}${nudge}`;

    $('submit').disabled = bottles === 0 || belowMin || !menu.orderingOpen || menu.dates.length === 0;

  }

  // ---------------------------------------------------------------------------
  // Cloudflare Turnstile (bot check). Loaded only after the code is accepted.
  // ---------------------------------------------------------------------------
  function loadTurnstile() {
    if (DEMO || turnstileWidget !== null) return;
    window.onTurnstileLoad = () => {
      turnstileWidget = window.turnstile.render('#turnstile', {
        sitekey: menu.turnstileSiteKey,
        callback: (token) => { turnstileToken = token; },
        'expired-callback': () => { turnstileToken = ''; },
        'error-callback': () => { turnstileToken = ''; },
      });
    };
    document.head.append(el('script', {
      src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad',
      async: true,
    }));
  }

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------
  $('order-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = $('order-error');
    errorBox.hidden = true;
    const fail = (msg) => { errorBox.textContent = msg; errorBox.hidden = false; errorBox.scrollIntoView({ block: 'center' }); };

    const dateInput = document.querySelector('input[name="date"]:checked');
    if (!dateInput) return fail('Please pick a date.');
    if (!$('name').value.trim()) return fail('Please enter your name.');
    if (!/^\+?[\d\s\-()]{8,15}$/.test($('phone').value.trim())) return fail('Please enter your 8-digit mobile number.');
    if (fulfilment() === 'delivery' && $('address').value.trim().length < 5) return fail('Please enter your delivery address.');
    if (!$('consent').checked) return fail('Please tick the personal data agreement.');
    if (!DEMO && !turnstileToken) return fail('Please wait for the security check to finish, then try again.');

    const btn = $('submit');
    btn.disabled = true;
    btn.textContent = 'Placing order…';

    const { ok, data } = await post('/api/orders', {
      code,
      turnstileToken,
      dateId: Number(dateInput.value),
      fulfilment: fulfilment(),
      address: fulfilment() === 'delivery' ? $('address').value : '',
      name: $('name').value,
      phone: $('phone').value,
      notes: $('notes').value,
      consent: $('consent').checked,
      items: cartItems(),
    }).catch(() => ({ ok: false, data: { error: 'Network problem. Your order was not placed. Please try again.' } }));

    btn.textContent = 'Place order →';
    // Turnstile tokens are single-use: always get a fresh one after a submit
    if (!DEMO && window.turnstile && turnstileWidget !== null) { window.turnstile.reset(turnstileWidget); turnstileToken = ''; }

    if (!ok) { updateTotal(); return fail(data.error || 'Your order was not placed. Please try again.'); }

    storage.set('mincho_name', $('name').value.trim());
    storage.set('mincho_phone', $('phone').value.trim());
    showReceipt(data);
  });

  // ---------------------------------------------------------------------------
  // Navigation back
  // ---------------------------------------------------------------------------
  // Receipt → fresh order form (same code, empty cart, details kept)
  $('again').addEventListener('click', () => {
    qty.clear();
    $('notes').value = '';
    $('done').hidden = true;
    renderOrderForm();
    window.scrollTo({ top: 0 });
  });

  // Shop closed → "Check again": re-ask the server with the same code.
  // Still closed: say so with the time, so the tap visibly did something.
  // Code no longer valid (owners made a new one): back to the invite page.
  $('closed-retry').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const msg = $('closed-msg');
    btn.disabled = true;
    msg.hidden = true;
    const { ok, status, data } = await post('/api/menu', { code }).catch(() => ({ ok: false, status: 0, data: { error: 'Network problem. Please try again.' } }));
    btn.disabled = false;
    const time = new Date().toLocaleTimeString('en-SG', { hour: 'numeric', minute: '2-digit' });
    if (ok) {
      menu = data;
      if (!closedReason(menu)) { renderOrderForm(); return; }
      setClosedWording(closedReason(menu)); // still closed; the reason may have changed
      msg.textContent = `Still closed (checked at ${time}).`;
      msg.hidden = false;
      return;
    }
    // Only a refused code (403) sends them back; a network or server hiccup just says so.
    if (status !== 403) { msg.textContent = data.error || 'Could not check. Please try again.'; msg.hidden = false; return; }
    storage.del('mincho_code');
    code = '';
    $('closed').hidden = true;
    $('gate').hidden = false;
    $('gate-error').textContent = data.error || 'Could not load the menu.';
    $('gate-error').hidden = false;
    window.scrollTo({ top: 0 });
  });

  // Order form → invite page (forgets the remembered code on this device)
  $('change-code').addEventListener('click', () => {
    storage.del('mincho_code');
    code = '';
    $('code').value = '';
    $('order-form').hidden = true;
    $('gate').hidden = false;
    $('code').focus();
    window.scrollTo({ top: 0 });
  });

  // ---------------------------------------------------------------------------
  // Step 3: receipt with PayNow instructions
  // ---------------------------------------------------------------------------
  function copyButton(text) {
    const btn = el('button', { type: 'button', className: 'small secondary', textContent: 'Copy' });
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
      catch { btn.textContent = 'Select and copy'; }
    });
    return btn;
  }

  function showReceipt(o) {
    $('order-form').hidden = true;
    const done = $('done');
    const at = new Date(`${o.date}T00:00:00+08:00`);
    const niceDate = at.toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore', weekday: 'long', day: 'numeric', month: 'long' });
    const shortDate = at.toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short' });
    const amount = (o.totalCents / 100).toFixed(2);

    const rows = o.items.map((i) => el('tr', {},
      el('td', {}, el('b', { textContent: i.product_name }), el('small', { textContent: `${sizeLabel(i.size_ml)} ${containerFor(i.size_ml, i)} × ${i.qty}` })),
      el('td', { className: 'amt', textContent: money(i.line_total_cents) })));
    if (o.deliveryFeeCents) rows.push(el('tr', {}, el('td', {}, el('b', { textContent: 'Delivery' })), el('td', { className: 'amt', textContent: money(o.deliveryFeeCents) })));

    const payline = (label, value, copyValue) => el('div', { className: 'copyline' },
      el('span', {}, el('small', { textContent: label }), el('code', { textContent: value })),
      copyButton(copyValue));

    $('chit').replaceChildren(
      el('div', { className: 'chit-top' },
        el('span', { className: 'logo' }, el('span', { className: 'logo-name', textContent: 'MinCho' }), el('span', { className: 'logo-cafe', textContent: 'Cafe' }), el('span', { className: 'logo-hk', lang: 'zh-Hant', textContent: '港式茶' })),
        el('div', { className: 'stamp', ariaHidden: 'true' }, el('b', { lang: 'zh-Hant', textContent: '已收到' }), el('small', { textContent: 'RECEIVED' }))),
      el('p', { className: 'chit-label' }, 'Order reference / ', el('span', { lang: 'zh-Hant', textContent: '訂單編號' })),
      el('div', { className: 'ref', textContent: o.orderRef }),
      el('p', { className: 'hint', textContent: `${o.fulfilment === 'delivery' ? 'Delivery' : 'Collection'} on ${niceDate}` }),
      el('table', {},
        el('thead', {}, el('tr', {}, el('th', { textContent: 'Item' }), el('th', { textContent: 'Amount' }))),
        el('tbody', {}, ...rows),
        el('tfoot', {}, el('tr', {}, el('td', { textContent: 'Total' }), el('td', { className: 'amt', textContent: money(o.totalCents) })))),
      el('p', { className: 'chit-label', lang: 'zh-Hant', textContent: '下一步' }),
      el('h3', { textContent: 'Pay by PayNow' }),
      el('div', { className: 'paylines' },
        payline('PayNow to', `${o.paynowNumber.replace(/^(\d{4})(\d{4})$/, '$1 $2')} (QQ)`, o.paynowNumber),
        payline('Amount', `$${amount}`, amount),
        payline('Reference', o.orderRef, o.orderRef)),
      el('p', { className: 'notice', textContent: 'Please put the order reference in the PayNow reference or comments field so QQ can match your payment.' }),
      o.collectionNote ? el('p', { className: 'hint', textContent: o.collectionNote }) : '',
      el('p', { className: 'hint', textContent: 'Need to change or cancel? Message Ming Ming or QQ with your order reference.' }),
      el('div', { className: 'chit-foot' }, 'Thank you · ', el('span', { lang: 'zh-Hant', textContent: '多謝晒' }), ` · ${shortDate}`),
    );
    done.hidden = false;
    window.scrollTo({ top: 0 });
  }
})();
