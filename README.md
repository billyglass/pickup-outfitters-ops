# Pickup Outfitters — Shop Operations

Cloud-based, multi-user business management for Pickup Outfitters
(St. Ann, Missouri): customers, vehicles, quotes, invoices, receivables,
payables, and reporting. Built to tie into the Installer Job Tracker later.

**Phase 1 (this build):** user accounts + permissions, customers, vehicles,
global search, QuickBooks customer CSV import (Admin only).
Quotes / invoices are Phase 2, payments / receivables / payables Phase 3,
reporting Phase 4, installer integration Phase 5, templates / printing Phase 6.
Those screens exist as clearly-marked placeholders with no fake data.

Stack: Vite + React 18 + Supabase (Postgres + Auth), same as the Installer
Job Tracker. No extra paid services.

## Costs — read before daily use

- Build/test on free tiers: **$0, no payment method needed.**
- Before daily shop use, move to **Vercel Pro $20/mo** (Hobby is officially
  personal / non-commercial only) and **Supabase Pro $25/mo** (Free pauses
  after 1 week with no activity and has no automatic backups).

## Deploy — step by step

You already have the accounts from the tracker: GitHub `billyglass`,
Vercel via GitHub sign-in, Supabase. Reuse them; create a **new**
Supabase project for this app (separate from the tracker database).

### 1. Create the new Supabase project

1. Go to https://supabase.com → **New project**.
2. Name it e.g. `pickup-outfitters-ops`, set a database password
   (save it somewhere safe), pick a region near you (e.g. US East), create it.
3. Left sidebar → **SQL Editor** → **New query**. Open `supabase/schema.sql`
   from this repo, copy its entire contents, paste, click **Run**.
   This creates all tables, RLS policies, numbering sequences/functions,
   audit triggers, and seeds the settings row:
   tax 7.74%, invoice prefix `INV-` starting 1001, quote prefix `QT-`
   starting 1001, terms Net 30, quote validity 15 days. No seed customers.
4. Project Settings (gear) → **API**. Copy:
   - **Project URL** — `https://<ref>.supabase.co`
   - **anon public** key — the long `eyJ…` string.
   Only the **anon** key goes in the app. Never paste the `service_role`
   key anywhere in this project.

### 2. Create Bill's login (Admin, sole first user)

**Before sending any invite — set the Site URL (required).**
If this is skipped, Supabase invite / reset links redirect to
`http://localhost:3000` and the link fails on a phone with
"couldn't connect to the server". Do this first:

1. Supabase Dashboard → **Authentication** → **URL Configuration**.
2. **Site URL:** `https://pickup-outfitters-ops.vercel.app/`
3. **Redirect URLs:** add `https://pickup-outfitters-ops.vercel.app/**`
4. Save. Then send the invite below — and if an earlier invite was
   already sent with the wrong redirect, send a fresh one after this
   is set (the old link will still point at localhost).

**Set-password flow (in the app, no password is invented):**
An invited user clicks the invite link, lands on the live app, and
sees a **"Set your password"** screen (new password + confirm,
minimum 8 characters). On success they go straight to the Dashboard.
If the link expired, they use **"Forgot password?"** on the sign-in
screen, which emails a fresh link back to the live app. A signed-in
user can also change their password in **Settings → Change password**.

Then create the user:

1. Supabase Dashboard → **Authentication** → **Users** → **Add user**.
2. Email: `bglass@pickupoutfitters.com` (Bill's address — confirm this is
   the right one before creating it; the app does not invent a password).
3. Set a strong password, **or** use "Send email invite" / password recovery
   so Bill sets his own. **Do not put a password in this repo, in chat,
   or in any file.**
4. Copy the new user's UUID (click the user row).
5. **SQL Editor** → run:
   ```sql
   insert into public.profiles (id, name, email, role, active)
   values ('<paste-the-uuid-here>', 'Billy Glass', 'bglass@pickupoutfitters.com', 'admin', true);
   ```
6. Sign in at the deployed app with that email + password.
7. **Admin MFA:** Settings → Enroll MFA, scan the code in an authenticator
   app, verify. Then in SQL Editor:
   ```sql
   update public.profiles set mfa_enrolled = true where email = 'bglass@pickupoutfitters.com';
   ```
   MFA is required for Admin before daily use.
8. Add more users later the same way: Auth user first, then a
   `profiles` row with role `sales` or `admin`. There is no public signup.

To deactivate someone later: set `profiles.active = false` (blocks all
data access via RLS immediately) **and** disable the user in
Supabase Auth → Users, so they cannot log in at all. See the RLS
limitations note in `supabase/schema.sql`.

### 3. Put the code on GitHub

1. GitHub → **+ → New repository**, name it `pickup-outfitters-ops`,
   leave it Public (or Private — Vercel can import either), create it.
2. In this folder:
   ```bash
   git init
   git add .
   git commit -m "Pickup Outfitters Ops — Phase 1"
   git branch -M main
   git remote add origin https://github.com/billyglass/pickup-outfitters-ops.git
   git push -u origin main
   ```
   Never commit `.env` — it is in `.gitignore`. Only `.env.example` is committed.

### 4. Deploy on Vercel

1. https://vercel.com → **Add New… → Project** → **Import** `pickup-outfitters-ops`.
2. Expand **Environment Variables** and add:
   - `VITE_SUPABASE_URL` = the Project URL from step 1.4
   - `VITE_SUPABASE_ANON_KEY` = the anon public key from step 1.4
3. **Deploy.** You get a URL like `https://pickup-outfitters-ops.vercel.app`.
4. Open it, sign in as Bill, check Customers → New customer saves,
   and the Import tab shows the QuickBooks template download.

## Run locally

```bash
npm install
cp .env.example .env   # then fill in your Supabase URL + anon key
npm run dev            # http://localhost:5173
npm run build          # production build check (outputs to dist/)
```

Without a `.env` file the app runs in local mode (browser-only storage,
yellow banner, "Continue in local demo" on the login screen) so the UI
can be tried before Supabase is connected. Do not use local mode for real data.

## What Phase 1 enforces — and what it does not

- **Enforced in Postgres RLS:** Sales cannot select `payments`,
  `payment_allocations`, `vendors`, `vendor_bills`, `vendor_payments`,
  `product_costs`, `settings`, or `audit_log` — any query returns no rows,
  including via search, export, or a direct link. Costs are physically
  separated into `product_costs` (Admin-only table), because Postgres has
  no column-level RLS.
- **Atomic numbering:** `next_invoice_number()` / `next_quote_number()`
  use Postgres sequences + a unique constraint. Two users saving at the
  same second cannot get the same number. Manual renumbering
  (`admin_renumber_invoice`) keeps the old number in `previous_numbers`
  and advances the sequence past a manual number so it can't collide later.
- **Concurrency:** customers / vehicles / quotes / invoices carry a
  `version` integer. The app checks it before saving; if someone else
  saved first, you get a conflict warning and nothing is overwritten.
  Changes are logged to `audit_log` by a trigger.
- **VIN:** normalized (uppercase, alphanumeric only) and indexed for
  full / last-6 / last-8 search. A duplicate VIN warns in the vehicle
  form — it does not block, by design.
- **Not yet built:** quotes/invoices UI, payments, AR/AP, reports,
  template editor, printing, installer integration. Their tables exist
  in the schema as scaffolding; their screens are placeholders.
- **Not a general ledger.** This system covers invoicing, receivables,
  payables, payments, and operational reporting. Keep your existing
  accounting for GL / tax filing until a GL / QuickBooks integration
  is decided after Phase 4.

## RLS limitations — honest notes

Read the "RLS limitations" block at the end of `supabase/schema.sql`.
In short: (1) cost protection works by table separation, not by a view —
never add a cost column to a Sales-readable table; (2) deactivation
blocks data via RLS but does not revoke the Auth login — also disable
the user in Supabase Auth; (3) `SECURITY DEFINER` functions bypass RLS
by design and check `is_admin()` / `is_active_user()` internally —
do not remove those checks.
