-- Swagarage marketplace: roles, row-level security, privileges and audit.
--
-- Defence in depth:
--   1. Table privileges are revoked from anon/authenticated and granted back
--      only where needed (Supabase grants everything by default).
--   2. RLS is enabled on every table; policies decide which rows.
--   3. Writes that need business rules (quotes, role changes, imports) go
--      through SECURITY DEFINER functions that check the caller first.
-- All SECURITY DEFINER functions pin search_path to '' and fully qualify names.

-- ---------------------------------------------------------------------------
-- Role helpers
-- ---------------------------------------------------------------------------
create or replace function public.current_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role from public.profiles p where p.id = auth.uid();
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p.role in ('staff', 'admin') from public.profiles p where p.id = auth.uid()),
    false);
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p.role = 'admin' from public.profiles p where p.id = auth.uid()),
    false);
$$;

-- True when the statement runs as a trusted backend role (migrations,
-- service-role scripts), not as an end user through the API.
create or replace function public.is_backend()
returns boolean
language sql
stable
set search_path = ''
as $$
  -- API requests always carry JWT claims; direct connections (migrations,
  -- SQL editor, Supabase Auth's own writes) do not. current_user is NOT used
  -- because inside SECURITY DEFINER functions it is always the owner.
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role' is null
         or coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role' = 'service_role';
$$;

-- ---------------------------------------------------------------------------
-- New user -> profile
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name, company)
  values (
    new.id,
    lower(new.email),
    left(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), 120),
    left(nullif(trim(new.raw_user_meta_data ->> 'company'), ''), 160)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep profile email in step with auth email.
create or replace function public.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = lower(new.email) where id = new.id;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function public.handle_user_email_change();

-- Nobody but an admin (or the backend) may change a role, even if a
-- privilege is granted by mistake later.
create or replace function public.tg_guard_profile_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role is distinct from old.role and not (public.is_admin() or public.is_backend()) then
    raise exception 'Only an admin can change roles' using errcode = '42501';
  end if;
  if new.id is distinct from old.id
     or (new.email is distinct from old.email and not public.is_backend()) then
    raise exception 'Profile id and email cannot be changed here' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger profiles_guard_role before update on public.profiles
  for each row execute function public.tg_guard_profile_role();

-- ---------------------------------------------------------------------------
-- Audit trigger
-- ---------------------------------------------------------------------------
create or replace function public.tg_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row_id text;
begin
  v_row_id := coalesce(
    to_jsonb(coalesce(new, old)) ->> 'id',
    to_jsonb(coalesce(new, old)) ->> 'product_id',
    to_jsonb(coalesce(new, old)) ->> 'category_id',
    to_jsonb(coalesce(new, old)) ->> 'quote_id');
  insert into public.audit_log (actor_id, action, table_name, row_id, old_data, new_data)
  values (
    auth.uid(),
    tg_op,
    tg_table_name,
    v_row_id,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end;
$$;

create trigger audit_products after insert or update or delete on public.products
  for each row execute function public.tg_audit();
create trigger audit_product_internal after insert or update or delete on public.product_internal
  for each row execute function public.tg_audit();
create trigger audit_vendors after insert or update or delete on public.vendors
  for each row execute function public.tg_audit();
create trigger audit_vendor_offers after insert or update or delete on public.vendor_offers
  for each row execute function public.tg_audit();
create trigger audit_pricing_rules after insert or update or delete on public.pricing_rules
  for each row execute function public.tg_audit();
create trigger audit_profiles_role after update of role on public.profiles
  for each row execute function public.tg_audit();
create trigger audit_quotes after update on public.quotes
  for each row execute function public.tg_audit();

-- ---------------------------------------------------------------------------
-- Privileges: start from nothing, grant back the minimum.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated, public;

-- Public catalogue (rows further limited by RLS)
grant select on public.categories, public.collections, public.product_collections, public.products
  to anon, authenticated;

-- Staff catalogue management (RLS limits to staff)
grant insert, update, delete on public.categories, public.collections, public.product_collections, public.products
  to authenticated;
grant select, insert, update, delete on public.vendors, public.vendor_offers, public.product_internal, public.pricing_rules
  to authenticated;

-- Profiles: users may edit only these columns of their own row
grant select on public.profiles to authenticated;
grant update (full_name, company, phone) on public.profiles to authenticated;

-- Quotes: read only; every write goes through functions below
grant select on public.quotes, public.quote_items, public.quote_events to authenticated;
grant select on public.quote_internal to authenticated;

-- Audit + assistant log: read only (admins / staff via RLS)
grant select on public.audit_log, public.assistant_requests to authenticated;

-- Helper functions used inside policies must be executable
grant execute on function public.is_staff(), public.is_admin(), public.current_user_role() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table public.profiles            enable row level security;
alter table public.categories          enable row level security;
alter table public.collections         enable row level security;
alter table public.products            enable row level security;
alter table public.product_collections enable row level security;
alter table public.vendors             enable row level security;
alter table public.product_internal    enable row level security;
alter table public.vendor_offers       enable row level security;
alter table public.pricing_rules       enable row level security;
alter table public.quotes              enable row level security;
alter table public.quote_items         enable row level security;
alter table public.quote_events        enable row level security;
alter table public.quote_internal      enable row level security;
alter table public.assistant_requests  enable row level security;
alter table public.audit_log           enable row level security;

-- Profiles
create policy profiles_select_own_or_staff on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.is_staff()));
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Categories / collections: public read, staff write
create policy categories_read on public.categories for select to anon, authenticated using (true);
create policy categories_staff_write on public.categories for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
create policy collections_read on public.collections for select to anon, authenticated using (true);
create policy collections_staff_write on public.collections for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));

-- Products: anyone sees live products; staff see and edit everything.
create policy products_read_live on public.products
  for select to anon, authenticated
  using (status = 'live' or (select public.is_staff()));
create policy products_staff_insert on public.products
  for insert to authenticated with check ((select public.is_staff()));
create policy products_staff_update on public.products
  for update to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));
create policy products_admin_delete on public.products
  for delete to authenticated using ((select public.is_admin()));

create policy product_collections_read on public.product_collections
  for select to anon, authenticated
  using (exists (select 1 from public.products p
                 where p.id = product_id and (p.status = 'live' or (select public.is_staff()))));
create policy product_collections_staff_write on public.product_collections
  for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));

-- Internal tables: staff only, every operation
create policy vendors_staff on public.vendors for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
create policy product_internal_staff on public.product_internal for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
create policy vendor_offers_staff on public.vendor_offers for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
create policy pricing_rules_staff on public.pricing_rules for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));

-- Quotes: owner or staff can read. No insert/update/delete policies:
-- clients and staff change quotes only through the functions below.
create policy quotes_read on public.quotes for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_staff()));
create policy quote_items_read on public.quote_items for select to authenticated
  using (exists (select 1 from public.quotes q
                 where q.id = quote_id and (q.user_id = (select auth.uid()) or (select public.is_staff()))));
create policy quote_events_read on public.quote_events for select to authenticated
  using (exists (select 1 from public.quotes q
                 where q.id = quote_id and (q.user_id = (select auth.uid()) or (select public.is_staff()))));
create policy quote_internal_staff on public.quote_internal for select to authenticated
  using ((select public.is_staff()));

create policy assistant_requests_staff on public.assistant_requests for select to authenticated
  using ((select public.is_staff()));
create policy audit_log_admin on public.audit_log for select to authenticated
  using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- Business functions
-- ---------------------------------------------------------------------------

-- Client submits a quote request. Prices are taken from the database, never
-- from the browser. Limits: 1-50 lines, quantity >= product MOQ, 10 quotes
-- per user per 24 hours.
create or replace function public.submit_quote(p_quote jsonb)
returns table (quote_id uuid, quote_ref text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  v_items     jsonb := p_quote -> 'items';
  v_item      jsonb;
  v_product   public.products%rowtype;
  v_qty       integer;
  v_quote_id  uuid;
  v_ref       text;
  v_total     numeric(20,2) := 0;
  v_price     numeric(12,2);
  v_recent    integer;
  v_needed_by date;
begin
  if v_uid is null then
    raise exception 'You need to sign in to request a quote' using errcode = '42501';
  end if;
  if jsonb_typeof(p_quote) is distinct from 'object' or jsonb_typeof(v_items) is distinct from 'array' then
    raise exception 'Invalid quote payload' using errcode = '22023';
  end if;
  if jsonb_array_length(v_items) not between 1 and 50 then
    raise exception 'A quote needs between 1 and 50 products' using errcode = '22023';
  end if;

  -- Serialise submissions per user so parallel requests cannot race past
  -- the daily limit (found by the load/attack tests).
  perform pg_advisory_xact_lock(hashtext('submit_quote:' || v_uid::text));
  select count(*) into v_recent from public.quotes
   where user_id = v_uid and created_at > now() - interval '24 hours';
  if v_recent >= 10 then
    raise exception 'Too many quote requests today. Please try again tomorrow.' using errcode = '54000';
  end if;

  if nullif(p_quote ->> 'needed_by', '') is not null then
    v_needed_by := (p_quote ->> 'needed_by')::date;
    if v_needed_by < current_date then
      raise exception 'Needed-by date cannot be in the past' using errcode = '22023';
    end if;
  end if;

  v_ref := 'SG-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.quote_ref_seq')::text, 5, '0');

  insert into public.quotes (ref, user_id, contact_name, company, email, phone, occasion,
                             delivery_city, needed_by, notes)
  values (v_ref, v_uid,
          trim(p_quote ->> 'contact_name'),
          trim(p_quote ->> 'company'),
          lower(trim(p_quote ->> 'email')),
          nullif(trim(p_quote ->> 'phone'), ''),
          nullif(left(trim(p_quote ->> 'occasion'), 120), ''),
          nullif(left(trim(p_quote ->> 'delivery_city'), 80), ''),
          v_needed_by,
          nullif(left(trim(p_quote ->> 'notes'), 2000), ''))
  returning id into v_quote_id;

  for v_item in select value from jsonb_array_elements(v_items) loop
    select * into v_product from public.products
     where id = (v_item ->> 'product_id')::uuid and status = 'live';
    if not found then
      raise exception 'A product in your quote is no longer available' using errcode = '22023';
    end if;
    v_qty := (v_item ->> 'quantity')::integer;
    if v_qty is null or v_qty < v_product.moq or v_qty > 100000 then
      raise exception '% needs a quantity of at least %', v_product.name, v_product.moq using errcode = '22023';
    end if;
    if exists (select 1 from public.quote_items qi where qi.quote_id = v_quote_id and qi.product_id = v_product.id
               and coalesce(qi.colour, '') = coalesce(left(trim(v_item ->> 'colour'), 60), '')) then
      raise exception 'Duplicate line for %', v_product.name using errcode = '22023';
    end if;

    v_price := coalesce(v_product.sell_price, v_product.mrp);
    insert into public.quote_items (quote_id, product_id, product_sku, product_name, quantity,
                                    unit_price, price_basis, colour, branding)
    values (v_quote_id, v_product.id, v_product.sku, v_product.name, v_qty, v_price,
            case when v_product.sell_price is not null then 'gst_extra'::public.price_basis
                 else v_product.price_basis end,
            nullif(left(trim(v_item ->> 'colour'), 60), ''),
            nullif(left(trim(v_item ->> 'branding'), 200), ''));
    v_total := v_total + coalesce(v_price, 0) * v_qty;
  end loop;

  update public.quotes set estimate_total = v_total where id = v_quote_id;
  insert into public.quote_events (quote_id, actor_id, from_status, to_status, message)
  values (v_quote_id, v_uid, null, 'submitted', 'Quote request submitted');

  return query select v_quote_id, v_ref;
end;
$$;

-- Client cancels their own quote while it is still waiting.
create or replace function public.cancel_my_quote(p_quote_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.quote_status;
begin
  select status into v_status from public.quotes
   where id = p_quote_id and user_id = auth.uid()
   for update;
  if not found then
    raise exception 'Quote not found' using errcode = 'P0002';
  end if;
  if v_status not in ('submitted', 'in_review') then
    raise exception 'This quote can no longer be cancelled' using errcode = '22023';
  end if;
  update public.quotes set status = 'cancelled' where id = p_quote_id;
  insert into public.quote_events (quote_id, actor_id, from_status, to_status, message)
  values (p_quote_id, auth.uid(), v_status, 'cancelled', 'Cancelled by client');
end;
$$;

-- Staff move a quote through its pipeline and keep internal notes.
create or replace function public.staff_update_quote(
  p_quote_id uuid,
  p_status public.quote_status,
  p_message text default null,
  p_quoted_total numeric default null,
  p_internal_notes text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.quote_status;
begin
  if not public.is_staff() then
    raise exception 'Staff only' using errcode = '42501';
  end if;
  select status into v_old from public.quotes where id = p_quote_id for update;
  if not found then
    raise exception 'Quote not found' using errcode = 'P0002';
  end if;
  if p_quoted_total is not null and p_quoted_total < 0 then
    raise exception 'Quoted total cannot be negative' using errcode = '22023';
  end if;

  update public.quotes
     set status = p_status,
         quoted_total = coalesce(p_quoted_total, quoted_total)
   where id = p_quote_id;

  if p_status is distinct from v_old or nullif(trim(p_message), '') is not null then
    insert into public.quote_events (quote_id, actor_id, from_status, to_status, message)
    values (p_quote_id, auth.uid(), v_old, p_status, nullif(left(trim(p_message), 1000), ''));
  end if;

  if p_internal_notes is not null then
    insert into public.quote_internal (quote_id, notes, updated_at)
    values (p_quote_id, left(p_internal_notes, 4000), now())
    on conflict (quote_id) do update set notes = excluded.notes, updated_at = now();
  end if;
end;
$$;

-- Admin changes a user's role. The last admin cannot demote themselves.
create or replace function public.admin_set_role(p_user_id uuid, p_role public.user_role)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if p_role <> 'admin' and exists (select 1 from public.profiles where id = p_user_id and role = 'admin')
     and (select count(*) from public.profiles where role = 'admin') <= 1 then
    raise exception 'There must always be at least one admin' using errcode = '22023';
  end if;
  update public.profiles set role = p_role where id = p_user_id;
  if not found then
    raise exception 'User not found' using errcode = 'P0002';
  end if;
end;
$$;

-- Gift assistant usage log (authenticated users; 60 per hour).
create or replace function public.log_assistant_request(p_query text, p_product_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return;
  end if;
  if (select count(*) from public.assistant_requests
       where user_id = auth.uid() and created_at > now() - interval '1 hour') >= 60 then
    return;
  end if;
  insert into public.assistant_requests (user_id, query, product_ids)
  values (auth.uid(), left(trim(p_query), 500), coalesce(p_product_ids[1:30], '{}'));
end;
$$;

-- Recalculate sell prices from the cheapest vendor cost and the category
-- margin, never above MRP. Products without a cost keep their current price.
create or replace function public.recompute_sell_prices()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if not public.is_staff() then
    raise exception 'Staff only' using errcode = '42501';
  end if;
  with best as (
    select vo.product_id, min(vo.cost_price) as cost
      from public.vendor_offers vo
     where vo.cost_price is not null
     group by vo.product_id
  ), calc as (
    select p.id,
           ceil(b.cost * (1 + pr.margin_pct / 100)) as raw_price,
           p.mrp
      from public.products p
      join best b on b.product_id = p.id
      join public.pricing_rules pr on pr.category_id = p.category_id
  )
  update public.products p
     set sell_price = case when c.mrp is not null then least(c.raw_price, c.mrp) else c.raw_price end,
         price_basis = 'gst_extra'
    from calc c
   where p.id = c.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Bulk import / update of products from the proofreading sheet.
-- p_rows: array of objects keyed by the sheet's columns (see docs/IMPORT.md).
-- Matching is by sku. Returns counts of inserted and updated products.
create or replace function public.staff_import_products(p_rows jsonb)
returns table (inserted integer, updated integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row       jsonb;
  v_cat_id    smallint;
  v_prod_id   uuid;
  v_vendor_id uuid;
  v_ins       integer := 0;
  v_upd       integer := 0;
  v_existing  boolean;
  v_sku       text;
  v_slug      text;
  v_coll      text;
begin
  if not public.is_staff() then
    raise exception 'Staff only' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 3000 then
    raise exception 'Expected an array of at most 3000 rows' using errcode = '22023';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_sku := lower(trim(v_row ->> 'sku'));
    if v_sku is null or v_sku !~ '^[a-z0-9-]{2,40}$' then
      raise exception 'Invalid SKU: %', coalesce(v_row ->> 'sku', '(empty)') using errcode = '22023';
    end if;

    select id into v_cat_id from public.categories
     where lower(name) = lower(trim(v_row ->> 'category')) or slug = lower(trim(v_row ->> 'category'));
    if v_cat_id is null then
      raise exception 'Unknown category "%" for %', v_row ->> 'category', v_sku using errcode = '22023';
    end if;

    v_slug := coalesce(nullif(lower(trim(v_row ->> 'slug')), ''),
                       trim(both '-' from regexp_replace(lower(v_row ->> 'name'), '[^a-z0-9]+', '-', 'g')) || '-' || v_sku);
    v_existing := exists (select 1 from public.products where sku = v_sku);

    insert into public.products as p (sku, slug, name, brand, category_id, subcategory, description,
                                 features, specs, colours, image_path, mrp, sell_price, price_basis,
                                 moq, branding_possible, delivery_note, ready_stock, under_production, status)
    values (
      v_sku, v_slug,
      trim(v_row ->> 'name'),
      nullif(trim(v_row ->> 'brand'), ''),
      v_cat_id,
      nullif(trim(v_row ->> 'subcategory'), ''),
      nullif(trim(v_row ->> 'description'), ''),
      coalesce(array(select jsonb_array_elements_text(v_row -> 'features')), '{}'),
      coalesce(v_row -> 'specs', '{}'::jsonb),
      coalesce(array(select jsonb_array_elements_text(v_row -> 'colours')), '{}'),
      nullif(trim(v_row ->> 'image_path'), ''),
      nullif(v_row ->> 'mrp', '')::numeric,
      nullif(v_row ->> 'sell_price', '')::numeric,
      coalesce(nullif(v_row ->> 'price_basis', ''), 'on_request')::public.price_basis,
      coalesce(nullif(v_row ->> 'moq', '')::integer, 25),
      coalesce((v_row ->> 'branding_possible')::boolean, true),
      nullif(trim(v_row ->> 'delivery_note'), ''),
      nullif(v_row ->> 'ready_stock', '')::integer,
      coalesce((v_row ->> 'under_production')::boolean, false),
      coalesce(nullif(v_row ->> 'status', ''), 'review')::public.product_status)
    on conflict (sku) do update set
      name = excluded.name, brand = excluded.brand, category_id = excluded.category_id,
      subcategory = excluded.subcategory, description = coalesce(excluded.description, p.description),
      features = excluded.features, specs = excluded.specs, colours = excluded.colours,
      image_path = coalesce(excluded.image_path, p.image_path), mrp = excluded.mrp,
      sell_price = coalesce(excluded.sell_price, p.sell_price),
      price_basis = excluded.price_basis, moq = excluded.moq,
      branding_possible = excluded.branding_possible, delivery_note = coalesce(excluded.delivery_note, p.delivery_note),
      ready_stock = excluded.ready_stock, under_production = excluded.under_production,
      status = excluded.status
    returning p.id into v_prod_id;

    if v_existing then v_upd := v_upd + 1; else v_ins := v_ins + 1; end if;

    insert into public.product_internal (product_id, source_ref, data_origin, proofread_status)
    values (v_prod_id, nullif(trim(v_row ->> 'source_ref'), ''), nullif(trim(v_row ->> 'data_origin'), ''),
            coalesce(nullif(v_row ->> 'proofread_status', ''), 'unchecked')::public.proofread_status)
    on conflict (product_id) do update set
      source_ref = coalesce(excluded.source_ref, public.product_internal.source_ref),
      data_origin = coalesce(excluded.data_origin, public.product_internal.data_origin),
      proofread_status = excluded.proofread_status;

    -- Optional logo rule (column added in the scale_and_ops migration).
    if nullif(v_row ->> 'logo_action', '') is not null then
      update public.product_internal set logo_action = (v_row ->> 'logo_action')::public.logo_action
       where product_id = v_prod_id;
    end if;

    if nullif(trim(v_row ->> 'vendor'), '') is not null then
      insert into public.vendors (name) values (trim(v_row ->> 'vendor'))
      on conflict (name) do nothing;
      select id into v_vendor_id from public.vendors where name = trim(v_row ->> 'vendor');
      insert into public.vendor_offers (product_id, vendor_id, vendor_sku, cost_price, vendor_mrp, stock, last_checked)
      values (v_prod_id, v_vendor_id, nullif(trim(v_row ->> 'vendor_sku'), ''),
              nullif(v_row ->> 'cost_price', '')::numeric, nullif(v_row ->> 'mrp', '')::numeric,
              coalesce(v_row -> 'stock', '{}'::jsonb), nullif(v_row ->> 'stock_checked', '')::date)
      on conflict (product_id, vendor_id) do update set
        vendor_sku = coalesce(excluded.vendor_sku, public.vendor_offers.vendor_sku),
        cost_price = coalesce(excluded.cost_price, public.vendor_offers.cost_price),
        vendor_mrp = excluded.vendor_mrp,
        stock = case when excluded.stock = '{}'::jsonb then public.vendor_offers.stock else excluded.stock end,
        last_checked = coalesce(excluded.last_checked, public.vendor_offers.last_checked);
    end if;

    if v_row ? 'collections' then
      delete from public.product_collections where product_id = v_prod_id;
      for v_coll in select jsonb_array_elements_text(v_row -> 'collections') loop
        insert into public.product_collections (product_id, collection_id)
        select v_prod_id, c.id from public.collections c
         where lower(c.name) = lower(trim(v_coll)) or c.slug = lower(trim(v_coll))
        on conflict do nothing;
      end loop;
    end if;
  end loop;

  return query select v_ins, v_upd;
end;
$$;

-- Lock down every function defined above (Supabase's default privileges
-- grant new functions to anon/authenticated), then grant back explicitly.
revoke all on all functions in schema public from anon, authenticated, public;
grant execute on function public.is_staff(), public.is_admin(), public.current_user_role() to anon, authenticated;
grant execute on function public.submit_quote(jsonb) to authenticated;
grant execute on function public.cancel_my_quote(uuid) to authenticated;
grant execute on function public.staff_update_quote(uuid, public.quote_status, text, numeric, text) to authenticated;
grant execute on function public.admin_set_role(uuid, public.user_role) to authenticated;
grant execute on function public.log_assistant_request(text, uuid[]) to authenticated;
grant execute on function public.recompute_sell_prices() to authenticated;
grant execute on function public.staff_import_products(jsonb) to authenticated;

-- Future tables/functions created in public must also start locked down.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated, public;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
