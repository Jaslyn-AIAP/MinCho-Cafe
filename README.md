# Ming’s Home Brew Tea — order site

_Formerly MinCho Cafe. The web address, repository, Supabase organisation and internal names (`mincho-…`) keep the old name; only what customers and owners see changed (11 Oct 2026)._

Invite-only ordering for Ming’s Home Brew Tea (owners: Ming and QQ). Customers enter a shared invite code, pick a date and their tea (sizes such as 250 ml, 500 ml and 1 L, each as a packet or a bottle, set by the owners), and pay by PayNow. Owners manage everything from `/admin`.

- **Hosting:** Cloudflare Pages (static pages + server functions), free plan
- **Database and owner login:** Supabase (PostgreSQL + Auth), free plan
- **Bot protection:** Cloudflare Turnstile, free plan
- **Notifications:** admin page (always), Telegram (optional, free), email (optional)

> Click paths below were written in October 2026. Dashboards change; if a label differs, look for the nearest equivalent.

---

## 1. How it works

```
Customer browser ──► Cloudflare Pages
                       ├─ /            order page (static)
                       ├─ /admin       owners' page (static)
                       └─ /api/*       server functions ──► Supabase (secret key)
                                                       ──► Turnstile check
                                                       ──► Telegram / email
Owner browser (/admin) ──► Supabase directly (publishable key + owner login,
                           protected by Row Level Security)
```

| Rule | Where it is enforced |
|---|---|
| Prices are calculated on the server, never trusted from the browser | `lib/rules.js` → `priceItems()` |
| Only people with the current invite code can see the menu or order | `functions/api/menu.js`, `orders.js` |
| Orders close at the cutoff (default: 11:59 pm Singapore time the day before) | `lib/rules.js` → `isDateOpen()` |
| Customers can't read any database table | Row Level Security, `supabase/schema.sql` |
| Only accounts in the `admins` table can see orders or change settings | Row Level Security + `is_admin()` |
| Max 5 orders per hour per network | `orders.js` (salted IP hash, raw IP not stored) |
| Addresses are only collected when delivery is on and chosen | `orders.js` + database check constraint |
| Only the PayNow account holder (QQ) can confirm a payment or mark a refund | Database trigger `orders_guard_and_stamp()` + `admins.can_confirm_payments` |
| Who did each step, and when, is recorded by the database, not the browser | Same trigger |
| Secrets live only in Cloudflare environment variables | `lib/server.js` header comment |

## 2. Accounts and who owns what

For now Jaslyn owns all three accounts (agreed with the owners while the customer base is small and known personally). The setup below keeps a clean path to hand Supabase, which holds the customer data, to the shop later. See section 12.

| Service | Owner now | Notes |
|---|---|---|
| GitHub (this code) | Jaslyn | Public showcase repository |
| Cloudflare (hosting, bot check) | Jaslyn | |
| Supabase (database, owner logins) | Jaslyn, inside a **separate "MinCho Cafe" organisation** | Holds customers' personal data; can be handed over later without moving anything |

1. Turn on two-factor login on all three accounts.
2. The repository is public, so **never commit secrets**. Keys live only in Cloudflare's environment variables (step 5), and `.dev.vars` is git-ignored.

## 3. Supabase setup

1. **Create a new organisation** named `MinCho Cafe` (do not use your personal one), then inside it **New project** → name `mincho-cafe`, region **Southeast Asia (Singapore)**, set a strong database password (store it in a password manager).
2. **SQL Editor → New query** → paste all of `supabase/schema.sql` → **Run**. Expect "Success. No rows returned". A fresh install needs only this file: it already includes everything from the `migrations_00x` files (section 9).
3. **Turn off public sign-up:** **Authentication → Sign In / Providers** → turn off **Allow new users to sign up** → Save.
4. **Owner logins:** nothing to do here. The first owner is created on the site itself (step 6), and further owners are added from the owners' page.
5. **Get the keys:** **Project Settings → API Keys**. You need:
   - Project URL (`https://xxxx.supabase.co`, shown under **Data API** or on the project home)
   - **Publishable key** (`sb_publishable_…`): safe to expose
   - **Secret key** (`sb_secret_…`): treat like a password

   Use the new publishable/secret keys, not the legacy `anon` / `service_role` keys. Supabase says the legacy keys are being deprecated by the end of 2026. The code accepts either.

## 4. Turnstile setup

**Cloudflare dashboard → Turnstile → Add widget** → name `MinCho Cafe`, hostname `mincho-cafe.pages.dev` (your real Pages hostname), mode **Managed** → Create. Copy the **Site key** and **Secret key**.

## 5. Cloudflare Pages setup

1. Push this folder to Jaslyn's GitHub repository.
2. Logged in to Cloudflare: **Workers & Pages → Create**. The page offers Workers first; choose the Pages option (in October 2026 a link at the bottom read "Looking to deploy Pages? **Get started**") → **Import an existing Git repository** → authorise GitHub for **this repository only** → choose it. Every push to the main branch then redeploys the site. Use Git, not direct upload: a direct-upload project can't be switched to Git later.
3. Build settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `public`
   - Root directory: *(leave empty)*. The `functions/` folder at the root becomes `/api/*` automatically.
4. **Settings → Variables and Secrets** (Production), add:

   | Name | Type | Value |
   |---|---|---|
   | `SUPABASE_URL` | Text | Project URL |
   | `SUPABASE_PUBLISHABLE_KEY` | Text | `sb_publishable_…` |
   | `SUPABASE_SERVICE_KEY` | **Secret** | `sb_secret_…` |
   | `TURNSTILE_SITE_KEY` | Text | Turnstile site key |
   | `TURNSTILE_SECRET_KEY` | **Secret** | Turnstile secret key |
   | `IP_HASH_SALT` | **Secret** | Any long random string (e.g. from a password generator) |
   | `SETUP_CODE` | **Secret** | A long random string you keep. Needed once, to create the first owner (step 6) |

5. **Deployments → Retry deployment** (variables only apply to new deployments).
6. The project name sets the address: `mincho-cafe` → `https://mincho-cafe.pages.dev`. If the name is taken, Cloudflare adds a suffix; update the Turnstile hostname to match.

## 6. First login and go-live checklist

1. Open `https://<your-site>/admin`. Because there are no owners yet, it shows **Set up the first owner**. Enter `SETUP_CODE`, your email and a password. This only works while there are no owners at all; afterwards the page shows the normal login. Keeping `SETUP_CODE` in Cloudflare is low risk for that reason (it only matters if every owner were deleted); deleting it is tidier.
2. **Your display name** (the first owner has none): SQL Editor → `update public.admins set display_name = 'Jaslyn' where email = '<your admin login email>';`. Check the email first with `select email from public.admins;`.
3. **Settings → Owners:** add each owner with a **Name** (shown on the orders they update, e.g. `QQ`), email and starting password.
4. **QQ's right to confirm payments and refunds** (only the PayNow account holder): `update public.admins set can_confirm_payments = true where email = '<QQ's login email>';`
5. **Settings:** enter QQ's real **PayNow number** (the database starts with a placeholder, 8000 0000, because this code is public) and Save.
6. **Settings → Make a new code** (replaces the placeholder `CHANGE-ME-…` code).
7. Check: collection note, order cutoff, delivery off. Then tick **Shop open** and Save. The shop starts closed on purpose, so it can't take orders before the PayNow number is set.
8. **The status line above the tabs** must be green ("✓ Taking orders for …"). If not, it lists everything still stopping orders (shop closed, no open date, no size or drink on sale), each with a link to fix it.
9. **Dates:** add collection dates.
10. Place a test order with your own phone, check it appears under **Orders**, then **Cancel order**.
11. **Copy link** and share it in the WhatsApp group.

## 6a. Owners' logins

1. Each owner logs in to `/admin` with the starting password Jaslyn gave them, then uses **Settings → Change my password**.
2. QQ turns on incoming PayNow alerts in her bank app: each alert with its `MC1017…` reference is the real proof of payment.
3. Check that the Telegram bot (if used) is in the owners' group chat, not a personal chat.

## 7. Notifications (optional)

| Channel | Cost | Setup effort | Notes |
|---|---|---|---|
| Admin page | Free | None | Always on. Refresh the Orders tab. |
| **Telegram** (recommended) | Free | ~10 minutes | Both owners in one group chat |
| Email via Resend | Free tier | ~15 minutes | Without your own domain, Resend's free plan can only email the address that signed up to Resend, so one owner only |

**Telegram:**
1. In Telegram, message **@BotFather** → `/newbot` → follow the prompts → copy the **bot token**.
2. Create a group with Ming and QQ, add the bot to it, and send any message in the group.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and find `"chat":{"id":-100…}`. That number (including the minus sign) is the chat id.
4. Add Pages variables `TELEGRAM_BOT_TOKEN` (Secret) and `TELEGRAM_CHAT_ID` (Text), then redeploy.

**Email (Resend):** sign up at resend.com with the owner's email, create an API key, add `RESEND_API_KEY` (Secret) and `NOTIFY_EMAIL` (that same email), then redeploy.

Notification failures never block an order; they are logged in **Pages → your project → Functions → Real-time logs**.

## 8. Keep the database awake

Supabase's free plan pauses a project after about 7 days of low activity ("a few requests each day" keeps it active). A paused project keeps its data, but the order form and admin page stop working until someone clicks **Resume project** in Supabase; it can be resumed for up to a year. The `keepalive-worker/` pings the site's `/api/health` twice a week (Monday and Thursday, 08:17 Singapore time) to prevent this. Supabase publishes no exact threshold; reads are enough, and real orders add activity too.

Set up in the Cloudflare dashboard (no install needed):
1. **Workers & Pages → Create → Start with Hello World!** Name it `mincho-keepalive`, **Deploy**.
2. **Edit code**: replace everything with `keepalive-worker/worker.js`, **Deploy**.
3. **Settings → Variables and Secrets → Add**: Text, `SITE_URL` = `https://mincho-cafe.pages.dev`, **Deploy**.
4. **Settings → Trigger events → Add → Cron Triggers**: `17 0 * * MON,THU`, **Add**.
5. Test any time by opening the worker's own address (`https://mincho-keepalive.<your-subdomain>.workers.dev/`): it runs the same check and shows `Result: 200 {"ok":true}`. Scheduled runs log `keepalive 200 {"ok":true}`.

(Alternative with Node.js installed: `cd keepalive-worker`, `npx wrangler login`, `npx wrangler deploy`.)

> Assumption: two reads a week through the API count as "activity". Supabase's own wording is "a few requests each day"; twice a week relies on community reports, not a documented guarantee. If the project still pauses: Supabase → the project → **Resume project**, then increase the schedule (e.g. `17 0 * * *` for daily).
>
> **Cron gotcha:** Cloudflare numbers weekdays from **1 = Sunday**, unlike standard cron. Use day names (`MON,THU`) and check the "upcoming events" list before saving.

## 9. Day-to-day use (owners)

**Every collection round**
- **New round:** Dates → add the date. It appears to customers automatically and closes at the order cutoff (Settings → days before, at a time). Adding a past date is refused; a date whose cutoff has passed is added with a warning.
- **Orders tab → pick the date → To brew:** the big number per drink is everything ordered for that date (cancelled excluded); **Still to collect** below it counts down as orders are ticked Collected.
- **After collection day:** **Download CSV** for that date. The free Supabase plan has no backups; this is the owners' copy.

**Payments** (each order has a payment step and a separate **Collected** tick)
- **Not paid → Screenshot received → Confirmed in bank.** A screenshot is only the customer's claim: a genuine screenshot can show a transfer scheduled for later that never goes through. Only **Confirmed in bank** counts as money received.
- **Only QQ** (the PayNow account holder) can set **Confirmed in bank**, or undo it; the database enforces it.
- Ticking **Collected** on an order that isn't confirmed asks "Hand over anyway?" first.
- The money tile splits **confirmed in bank / screenshot only / not paid**, and warns when tea was handed over before payment was confirmed.
- An amber box at the top of the Orders tab lists every screenshot not yet confirmed, across all dates, with how long it has waited.
- Every step records who did it and when, e.g. `Confirmed: QQ 2026-10-11T21:53:04+08:00` (Singapore time; also in the CSV).
- PayNow references look like `MC1017KQXV` (letters and digits only, because some bank apps refuse dashes). Orders before 11 Oct 2026 look like `MC1017-K7QF`; customers may type those without the dash.
- Customers WhatsApp their payment screenshots to Master Ming or QQ; screenshots are not uploaded to the site.

**Cancelling and refunds**
- **Cancel order** asks first if a payment is recorded ("QQ will need to check her bank and refund").
- A cancelled order with only a screenshot stays in QQ's list: confirm it if the money arrived, or set it to Not paid.
- A red **Refunds to make** box lists cancelled orders whose payment was confirmed. QQ refunds by PayNow, then sets **Refunded** (QQ only, and only after Confirmed in bank).

**Shop and menu**
- **Shop open** (Settings): unticked, customers see a "Shop closed" sign. With it ticked but no open date, or no size or drink on sale, they see an "Orders paused" sign. The status line above the tabs always says which, and what to fix.
- **Prices:** Menu & prices. Old orders keep the price they were placed at.
- **Sizes:** Menu & prices → Sizes. A size is a volume in ml plus **Packet** or **Bottle** (500 ml packet and 500 ml bottle are separate sizes at the same price, since price is per litre). Tick or untick each one; add one by typing ml (1 L = 1000).
- **Delivery:** Settings → tick **Offer delivery**, set the fee and Save. **Free delivery from** (e.g. 50) makes orders of that amount or more (drinks only) free to deliver; 0 = never free. **Minimum order:** 0 = none.
- **Code leaked?** Settings → **Make a new code**, then share the new link. The old link stops working.
- **Housekeeping:** Settings → Old orders → delete orders older than N days (default 90), for Personal Data Protection Act obligations not to keep personal data longer than needed.

Every admin action shows a ✓ / ⚠ / ✗ message with a timestamp; a refused field gets a red border.

## 9a. Database changes (migrations)

`supabase/schema.sql` always describes the full current database, so a **fresh install** needs only that. A database set up earlier is brought up to date by running these once each, in order, in the SQL Editor. All were run on the live database by 11 Oct 2026.

| File | What it adds |
|---|---|
| `migrations_002_free_delivery.sql` | Free-delivery threshold |
| `migrations_003_packets.sql` | Packet or bottle per size |
| `migrations_004_size_containers.sql` | A size is volume + container (500 ml packet and bottle can both exist) |
| `migrations_005_payment_confirmation.sql` | Payment steps, Collected, who/when records, QQ-only confirmation, owner display names |
| `migrations_006_refunds.sql` | Refunded step for cancelled orders (QQ only) |

Supabase warns "destructive operations" for 005 and 006: they replace rules (constraints, the trigger), not data. Each runs as all-or-nothing, and is safe to run again. Download the Orders CSV before running any migration.

## 10. Local development and tests

```bash
npm test                         # pricing, cutoff and order-flow tests (no network needed)
cp .dev.vars.example .dev.vars   # fill in a TEST Supabase project
npm run dev                      # runs the site locally with wrangler
```

## 11. Known limitations

- **PayNow is manual.** The site shows the number, amount and reference; it cannot see QQ's bank account. Payment is confirmed by QQ checking her bank and setting **Confirmed in bank**. A PayNow QR code could be added later but should be tested carefully with real banking apps first.
- **Customers can't edit or cancel orders themselves.** They message the owners, who change the status.
- **The invite code is shared.** Anyone who has it can order. Rotate it if it spreads too far.
- **No capacity limit per date** (as requested). Owners can close the shop with the **Shop open** switch (customers see a "Shop closed" sign). When every active date is past its cutoff, customers see an "Orders paused" sign until a new date is added.
- **Turnstile** blocks most bots but may challenge some VPN users.
- **Free plan limits** (checked October 2026): Pages Functions share the Workers free quota of 100,000 requests a day. Supabase free projects pause after about a week of low activity (the keep-alive worker prevents this; a paused project can be resumed for up to a year) and have no backups. Use **Download CSV** after each collection date.

## 12. Handing Supabase to the shop later

Do this when the shop grows (for example, when customers Jaslyn doesn't know start ordering) or whenever the owners want direct control of their customer data.

**Preferred: hand over the organisation (no migration).** Because the project lives in its own `MinCho Cafe` organisation, nothing moves:
1. The shop creates its own Supabase login (ideally with a shop email).
2. Jaslyn: **Organisation settings → Team → Invite** that email with the **Owner** role (invites last 24 hours).
3. Once they accept, Jaslyn clicks **Leave team**. An owner can leave once another owner exists.
4. The project URL and keys stay the same, so Cloudflare needs no changes.
5. If Jaslyn should also stop seeing orders, an owner removes her under **Settings → Owners** on the site.

Supabase documents the roles and the leave rule at https://supabase.com/docs/guides/platform/access-control.

**Fallback: transfer the project to another organisation.** Supabase supports this from the project's general settings. You must own the source organisation and be a member of the target, and the project must have no GitHub integration or log drains. Supabase's page doesn't say whether the URL or keys change, so check before relying on it: https://supabase.com/docs/guides/platform/project-transfer.

**Last resort: rebuild in a new project.** This is always possible because:
- `supabase/schema.sql` recreates every table and security rule.
- The site reads its database settings only from three Cloudflare variables (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_PUBLISHABLE_KEY`). Change them and redeploy.
- Order data must be copied across. The **Download CSV** button on the Orders tab gives the owners their own records; a full database copy needs Supabase's export tools.
- Owner logins don't copy across. Re-create the first owner with `SETUP_CODE`, then add the others under **Settings → Owners**, and re-run the display-name and `can_confirm_payments` lines from section 6.

**Meanwhile:** Supabase's free plan has no automatic backups, so download the CSV after each collection date.

## Files

| Path | What it is |
|---|---|
| `public/index.html`, `order.js` | Customer order page |
| `public/admin.html`, `admin.js` | Owners' page |
| `public/styles.css` | Shared styles (light and dark colours) |
| `public/theme.js` | Light/dark switch; follows the phone's setting until tapped |
| `public/_headers` | Security headers (Content Security Policy etc.) |
| `public/vendor/supabase-2.116.0.js` | Supabase client library, self-hosted (MIT licence) |
| `functions/api/menu.js` | Menu for valid invite codes |
| `functions/api/orders.js` | Order validation, pricing, saving, notifications |
| `functions/api/admin-config.js` | Gives the admin page the public Supabase URL and key |
| `functions/api/owners.js` | List, add and remove owners (owners only) |
| `functions/api/setup.js` | One-time creation of the first owner, protected by `SETUP_CODE` |
| `functions/api/health.js` | Used by the keep-alive worker |
| `lib/rules.js` | Pricing, cutoff, phone and reference rules (unit-tested) |
| `lib/server.js` | Supabase, Turnstile, hashing and notification helpers |
| `supabase/schema.sql` | Tables, security policies, the payment guard trigger and starting data (complete for a fresh install) |
| `supabase/migrations_00x_*.sql` | One-off upgrades for a database set up earlier (section 9a) |
| `keepalive-worker/` | Twice-weekly ping so Supabase doesn't pause; its own address runs a manual check (section 8) |
| `tests/` | Automated tests |
