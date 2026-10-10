# MinCho Cafe — order site

Invite-only ordering for MinCho Cafe (Ming Ming & QQ). Customers enter a shared invite code, pick a date and their tea (250 ml packets, 500 ml and 1 L bottles), and pay by PayNow. Owners manage everything from `/admin`.

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
2. **SQL Editor → New query** → paste all of `supabase/schema.sql` → **Run**. Expect "Success. No rows returned".
3. **Turn off public sign-up:** **Authentication → Sign In / Providers** → turn off **Allow new users to sign up** → Save.
4. **Owner logins:** nothing to do here. The first owner is created on the site itself (step 6), and further owners are added from the owners' page.
6. **Get the keys:** **Project Settings → API Keys**. You need:
   - Project URL (`https://xxxx.supabase.co`, shown under **Data API** or on the project home)
   - **Publishable key** (`sb_publishable_…`): safe to expose
   - **Secret key** (`sb_secret_…`): treat like a password

   Use the new publishable/secret keys, not the legacy `anon` / `service_role` keys. Supabase says the legacy keys are being deprecated by the end of 2026. The code accepts either.

## 4. Turnstile setup

**Cloudflare dashboard → Turnstile → Add widget** → name `MinCho Cafe`, hostname `mincho-cafe.pages.dev` (your real Pages hostname), mode **Managed** → Create. Copy the **Site key** and **Secret key**.

## 5. Cloudflare Pages setup

1. Push this folder to Jaslyn's GitHub repository.
2. Logged in to Cloudflare: **Workers & Pages → Create → Pages → Connect to Git** → authorise GitHub → choose the repository. Every push to the main branch then redeploys the site.
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

1. Open `https://<your-site>/admin`. Because there are no owners yet, it shows **Set up the first owner**. Enter `SETUP_CODE`, your email and a password. This only works once; afterwards the page shows the normal login. You can then delete `SETUP_CODE` from Cloudflare.
2. **Settings → Owners:** add Ming Ming and QQ with a starting password each.
3. **Settings:** enter QQ's real **PayNow number** (the database starts with a placeholder, 8000 0000, because this code is public) and Save.
4. **Settings → Make a new code** (replaces the placeholder `CHANGE-ME-…` code).
5. Check: collection note, cutoff (default 1 day before at 23:59), delivery off. Then tick **Shop open** and Save. The shop starts closed on purpose, so it can't take orders before the PayNow number is set. The line above the tabs always says what customers currently see.
6. **Dates:** 17 Oct and 24 Oct 2026 are already there. Add future dates here.
7. Place a test order with your own phone, check it appears under **Orders**, then set it to **Cancelled**.
8. **Copy link** and share it in the WhatsApp group.

## 6a. Owners' logins

1. Ming Ming and QQ log in to `/admin` with the starting passwords Jaslyn gave them, then use **Settings → Change my password**.
2. Check that the Telegram bot (if used) is in the owners' group chat, not a personal chat.

## 7. Notifications (optional)

| Channel | Cost | Setup effort | Notes |
|---|---|---|---|
| Admin page | Free | None | Always on. Refresh the Orders tab. |
| **Telegram** (recommended) | Free | ~10 minutes | Both owners in one group chat |
| Email via Resend | Free tier | ~15 minutes | Without your own domain, Resend's free plan can only email the address that signed up to Resend, so one owner only |

**Telegram:**
1. In Telegram, message **@BotFather** → `/newbot` → follow the prompts → copy the **bot token**.
2. Create a group with Ming Ming and QQ, add the bot to it, and send any message in the group.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and find `"chat":{"id":-100…}`. That number (including the minus sign) is the chat id.
4. Add Pages variables `TELEGRAM_BOT_TOKEN` (Secret) and `TELEGRAM_CHAT_ID` (Text), then redeploy.

**Email (Resend):** sign up at resend.com with the owner's email, create an API key, add `RESEND_API_KEY` (Secret) and `NOTIFY_EMAIL` (that same email), then redeploy.

Notification failures never block an order; they are logged in **Pages → your project → Functions → Real-time logs**.

## 8. Keep the database awake

Supabase's free plan pauses a project after about a week with no activity, and a paused project must be restored by hand from the dashboard. Orders are weekly, so one quiet week could break the order form. The `keepalive-worker/` pings the site once a day:

```bash
# From a computer with Node.js installed, inside the keepalive-worker folder.
# First edit SITE_URL in wrangler.toml to your real Pages address.
npx wrangler login      # opens a browser to log in to the owners' Cloudflare account
npx wrangler deploy     # deploys the worker with its daily schedule
```

Check it under **Workers & Pages → mincho-keepalive → Logs** the next day.

> Assumption: a daily read through the API counts as "activity" for Supabase. This is widely reported to work but is not a documented guarantee. If the project still pauses, the options are restoring it from the dashboard or moving to the Supabase Pro plan.

## 9. Day-to-day use (owners)

- **New week:** Dates → add the date. It appears to customers automatically and closes at the cutoff.
- **Before brewing:** Orders → pick the date → **To brew** shows litres, packets and bottles per drink (cancelled orders excluded).
- **Payments:** match PayNow references (e.g. `MC1017-K7QF`) and set the order to **Paid**, then **Collected**.
- **Turn on delivery later:** Settings → tick **Offer delivery**, set the fee and Save. Customers then see a Delivery option and an address box.
- **Free delivery:** Settings → **Free delivery for orders from** (e.g. 50). Orders of that amount or more, counting drinks only, deliver free; smaller orders pay the delivery fee. 0 = never free. If the database was set up before this setting existed, run `supabase/migrations_002_free_delivery.sql` once in the SQL Editor.
- **Minimum order:** Settings → Minimum order (0 = none).
- **Change prices:** Menu & prices. Old orders keep the price they were placed at.
- **Sizes:** Menu & prices → Sizes. Untick a size to stop offering it, or add one and choose **Packet** or **Bottle**. Its price is worked out from the price per litre.
- **Database set up before 10 Oct 2026 evening?** Run `supabase/migrations_003_packets.sql` once in the SQL Editor (adds packet/bottle).
- **Code leaked?** Settings → **Make a new code**, then share the new link.
- **Housekeeping:** Settings → Old orders → delete orders older than N days (default 90). This supports Personal Data Protection Act obligations not to keep personal data longer than needed.

## 10. Local development and tests

```bash
npm test                         # pricing, cutoff and order-flow tests (no network needed)
cp .dev.vars.example .dev.vars   # fill in a TEST Supabase project
npm run dev                      # runs the site locally with wrangler
```

## 11. Known limitations

- **PayNow is manual.** The site shows the number, amount and reference. It does not confirm payment; owners mark orders as paid. A PayNow QR code could be added later but should be tested carefully with real banking apps first.
- **Customers can't edit or cancel orders themselves.** They message the owners, who change the status.
- **The invite code is shared.** Anyone who has it can order. Rotate it if it spreads too far.
- **No capacity limit per date** (as requested). Owners can close the shop with the **Shop open** switch (customers see a "Shop closed" sign). When every active date is past its cutoff, customers see an "Orders paused" sign until a new date is added.
- **Turnstile** blocks most bots but may challenge some VPN users.
- **Free plan limits** (checked October 2026): Pages Functions share the Workers free quota of 100,000 requests a day; Supabase free projects pause after a week of inactivity and have no backups. Use **Download CSV** on the Orders tab if you want your own copy.

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
- Owner logins don't copy across. Re-create the first owner with `SETUP_CODE`, then add the others under **Settings → Owners**.

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
| `supabase/schema.sql` | Tables, security policies and starting data |
| `keepalive-worker/` | Daily ping so Supabase doesn't pause |
| `tests/` | Automated tests |
