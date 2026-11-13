# Security model

The browser is untrusted. Every rule that matters is enforced in the database, so a modified client, a bypassed route guard or a hand-crafted API call gets nothing it shouldn't.

## Roles

| Role | Can |
|---|---|
| anonymous | read **live** products, categories, collections |
| client | the above + own profile (name, company, phone only), own quotes, submit and cancel own quotes |
| staff | everything in the catalogue (all statuses), internal notes, all quotes and their pipeline, import. **Not** suppliers, costs or pricing rules |
| admin | staff + change roles, audit log, delete products |

Roles live in `public.profiles.role`. Sign-up never sets a role (metadata is ignored). Only `admin_set_role()` changes it, only for admins, and the last admin cannot be removed. A trigger blocks role changes from anywhere else.

## Layers

1. **Privileges.** Supabase grants everything to API roles by default; the migrations revoke all of it and grant back only what's listed above. New tables and functions start locked (`alter default privileges`).
2. **Row-level security** on every table.
3. **Data separation.** What clients must never see is in separate tables, not in hidden columns. `vendors`, `vendor_offers` (costs) and `pricing_rules` are closed to every app user, staff and admins included: only the database owner (Supabase SQL editor) can read them, and selling prices are computed inside the database. `product_internal`, `quote_internal` and `audit_log` are staff-only.
4. **Business rules in `SECURITY DEFINER` functions** with `search_path = ''`:
   - `submit_quote`: signed-in only, 1-50 lines, quantity ≥ product MOQ, only live products, **prices read from the database (never from the browser)**, 10 quotes per user per 24 h.
   - `cancel_my_quote`, `staff_update_quote`, `admin_set_role`, `staff_import_products`, `recompute_sell_prices`: each checks the caller's role first.
   - Clients and staff have **no** direct insert/update/delete on quotes.
5. **Constraints** on every column (lengths, formats, ranges) and `sell_price <= mrp`.
6. **Audit log**: triggers record who changed products, internal data, quotes and roles (never costs), with before/after values.
7. **Storage**: `product-images` is public-read; only staff can upload/replace/delete; images only, max 2 MB.

## Auth

Supabase Auth with PKCE, email confirmation required, passwords ≥ 10 characters with mixed case and digits (enforced in Auth settings and in the form). Login and reset forms give the same response whether an account exists or not. Redirects after login accept only same-site paths (no open redirects).

## Bot and abuse protection

Supabase Auth rate limits, optional Cloudflare Turnstile on sign-up, sign-in and password reset (`VITE_TURNSTILE_SITE_KEY`), 10 quote requests per account per 24 hours (race-safe), 60 assistant logs per hour, 50 lines per quote.

## Web

`vercel.json` sets a strict Content-Security-Policy (scripts only from the site, connections only to Supabase), HSTS, `X-Frame-Options: DENY`, `nosniff`, a referrer policy and a permissions policy. React escapes all output; there is no `dangerouslySetInnerHTML`. Only the public anon key is in the frontend; the service role key is used only by local scripts.

## Penetration test results (this build)

Attacks run against the database as anonymous, client and staff, plus browser attacks. Two real issues were found and fixed; every attack is now a regression test.

| Attack | Result |
|---|---|
| 30 parallel quote requests from one account to beat the 10/day limit | **Was possible (30 accepted). Fixed** with a per-user lock; now exactly 10 |
| Anonymous/clients executing internal database functions via Supabase's default grants | **Was possible (functions still refused bad callers). Fixed**: all functions revoked, explicit allow-list, plus an automatic inventory test |
| Read vendor costs/internal notes via joins, embeds, snapshot or filters | Blocked |
| Read drafts, other clients' quotes/items/history | Blocked |
| Self-promotion to staff/admin (direct update, sign-up metadata, RPC) | Blocked |
| Change own email/id, edit other users' profiles (incl. by staff) | Blocked |
| Tamper with or delete the audit log (incl. admins) | Blocked |
| Price tampering, negative/huge quantities, 51-line quotes, past dates, malformed JSON | Rejected cleanly |
| SQL injection via quote fields | Stored as text, no effect |
| Upload to product images or poison the CDN catalogue file (anon/client) | Blocked; staff limited to `v<number>.json` |
| Stored XSS through every product text field (name, brand, specs, colours, features) | Rendered as text; no script ran |
| Open redirect after login (`https://`, `//`, `/\`, `javascript:`, encoded) | Blocked |

## Tests

`npm run test:db` runs every migration on a throwaway PostgreSQL and runs the security suite, the attack suite, a privilege allow-list (fails if any table or function becomes reachable by anon/clients beyond the list, if any table lacks RLS, or if a SECURITY DEFINER function lacks a fixed search_path), feature tests, and a parallel race test. The security suite checks, as anonymous, two different clients, staff and admin: what each can read and write, MOQ, price tampering, rate limits, role escalation, cross-client access, storage uploads and the audit trail. The suite was checked by injecting holes on purpose (a client role-escalation path and a vendor-cost leak); both were caught.

## Before launch

- [ ] Custom SMTP for auth emails
- [ ] Turn on leaked-password protection and MFA for staff accounts (Supabase Pro)
- [ ] Point backups/PITR at a plan that includes them
- [ ] Rotate any key that was ever pasted into chat or a ticket
