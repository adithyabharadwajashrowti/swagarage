-- Catalogue v2: new categories, per-product GST, gift-box add-ons, slab pricing,
-- and vendor/cost data that no app user can read (not even staff or admins).

-- ---------------------------------------------------------------------------
-- Categories and collections
-- ---------------------------------------------------------------------------
insert into public.categories (slug, name, sort_order) values
  ('drinkware',     'Drinkware',              7),
  ('stationery',    'Pens & Stationery',      8),
  ('home-kitchen',  'Home & Lifestyle',       9),
  ('trophies',      'Trophies & Awards',     10),
  ('gift-sets',     'Gift Sets & Hampers',   11),
  ('gift-boxes',    'Gift Boxes',            12)
on conflict (slug) do nothing;

insert into public.collections (slug, name, description, sort_order) values
  ('new-arrivals', 'New Arrivals', 'Fresh additions to the Swagarage catalogue', 0)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- Products: GST rate (shown at checkout) and add-ons (gift boxes)
-- ---------------------------------------------------------------------------
alter table public.products
  add column if not exists gst_rate numeric(4,2) not null default 18
    check (gst_rate in (0, 3, 5, 12, 18, 28)),
  add column if not exists is_addon boolean not null default false;

-- Our price may be above the printed MRP (it includes branding and service).
alter table public.products drop constraint if exists sell_price_within_mrp;

-- ---------------------------------------------------------------------------
-- Slab pricing: vendor price (excl. GST) → selling price, rounded to ₹1.
-- The slabs themselves are business-confidential: they are NOT in this public
-- repository. The private catalogue import fills public.markup_slabs, which no
-- app user (admins included) can read.
-- ---------------------------------------------------------------------------
create table if not exists public.markup_slabs (
  up_to     numeric(12,2) check (up_to > 0),            -- null = everything above the other slabs
  inclusive boolean not null default true,               -- does "up to" include the boundary itself?
  factor    numeric(6,4) not null check (factor between 1 and 5)
);
alter table public.markup_slabs enable row level security;   -- no policies: database owner only
revoke all on table public.markup_slabs from anon, authenticated;

create or replace function public.markup_price(p_cost numeric)
returns numeric
language sql
stable
strict
set search_path = ''
as $$
  select round(p_cost * s.factor, 0)
    from public.markup_slabs s
   where s.up_to is null or p_cost < s.up_to or (s.inclusive and p_cost = s.up_to)
   order by s.up_to nulls last
   limit 1;
$$;

-- Recompute every selling price from the cheapest vendor cost. Backend only.
create or replace function public.recompute_sell_prices()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if not public.is_backend() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  with best as (
    select vo.product_id, min(vo.cost_price) as cost
      from public.vendor_offers vo
     where vo.cost_price is not null and vo.cost_price > 0
     group by vo.product_id
  )
  update public.products p
     set sell_price = public.markup_price(b.cost),
         price_basis = 'gst_extra'
    from best b
   where p.id = b.product_id
     and public.markup_price(b.cost) is not null
     and p.sell_price is distinct from public.markup_price(b.cost);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Prices follow vendor costs automatically whenever an offer changes.
create or replace function public.tg_offer_reprice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pid uuid := coalesce(new.product_id, old.product_id);
  v_cost numeric;
begin
  select min(cost_price) into v_cost
    from public.vendor_offers where product_id = v_pid and cost_price is not null and cost_price > 0;
  if v_cost is not null and public.markup_price(v_cost) is not null then
    update public.products set sell_price = public.markup_price(v_cost), price_basis = 'gst_extra'
     where id = v_pid and sell_price is distinct from public.markup_price(v_cost);
  end if;
  return null;
end;
$$;

drop trigger if exists offer_reprice on public.vendor_offers;
create trigger offer_reprice after insert or update of cost_price, product_id or delete on public.vendor_offers
  for each row execute function public.tg_offer_reprice();

-- ---------------------------------------------------------------------------
-- Confidentiality: vendors, costs and pricing are invisible to every app user.
-- Only the database owner (Supabase SQL editor / service role) can read them.
-- ---------------------------------------------------------------------------
drop policy if exists vendors_staff on public.vendors;
drop policy if exists vendor_offers_staff on public.vendor_offers;
drop policy if exists pricing_rules_staff on public.pricing_rules;
revoke all on public.vendors, public.vendor_offers, public.pricing_rules from anon, authenticated;

-- The audit log must not copy costs or vendor details where admins can read them.
drop trigger if exists audit_vendors on public.vendors;
drop trigger if exists audit_vendor_offers on public.vendor_offers;
drop trigger if exists audit_pricing_rules on public.pricing_rules;
delete from public.audit_log where table_name in ('vendors', 'vendor_offers', 'pricing_rules');

-- product_internal stays staff-only for proofreading, but never holds vendor names.
update public.product_internal set source_ref = null, data_origin = null
 where source_ref is not null or data_origin is not null;

revoke all on function public.recompute_sell_prices() from public, anon, authenticated;
revoke all on function public.markup_price(numeric) from public, anon, authenticated;
revoke all on function public.tg_offer_reprice() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Public catalogue: add GST rate and add-on flag; hide MRP when our price is above it.
-- ---------------------------------------------------------------------------
create or replace function public.build_catalogue_payload(p_version bigint)
returns json
language sql
stable
security definer
set search_path = ''
as $$
  select json_build_object(
    'version', p_version,
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'slug', c.slug, 'name', c.name, 'sort_order', c.sort_order)
                                             order by c.sort_order) from public.categories c), '[]'),
    'collections', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'slug', c.slug, 'name', c.name,
                                              'description', c.description, 'sort_order', c.sort_order) order by c.sort_order)
                               from public.collections c), '[]'),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'sku', p.sku, 'slug', p.slug, 'name', p.name, 'brand', p.brand, 'category_id', p.category_id,
        'subcategory', p.subcategory, 'description', p.description, 'features', p.features, 'specs', p.specs,
        'colours', p.colours, 'image_path', p.image_path,
        'mrp', case when p.sell_price is not null and p.mrp is not null and p.sell_price > p.mrp then null else p.mrp end,
        'sell_price', p.sell_price, 'price_basis', p.price_basis, 'moq', p.moq, 'branding_possible', p.branding_possible,
        'delivery_note', p.delivery_note, 'ready_stock', p.ready_stock, 'under_production', p.under_production,
        'status', p.status, 'updated_at', p.updated_at, 'gst_rate', p.gst_rate, 'is_addon', p.is_addon,
        'category', jsonb_build_object('id', c.id, 'slug', c.slug, 'name', c.name),
        'collection_slugs', coalesce((select jsonb_agg(co.slug) from public.product_collections pc
                                        join public.collections co on co.id = pc.collection_id
                                       where pc.product_id = p.id), '[]'))
        order by p.name)
      from public.products p join public.categories c on c.id = p.category_id
      where p.status = 'live'), '[]'))::json;
$$;
revoke all on function public.build_catalogue_payload(bigint) from public, anon, authenticated;

-- Quote estimates include each line's GST (shown to the client at checkout).
alter table public.quote_items add column if not exists gst_rate numeric(4,2);

-- Force the public snapshot to rebuild with the new fields.

-- ---------------------------------------------------------------------------
-- Import: product data only. Supplier and cost columns are ignored.
-- ---------------------------------------------------------------------------
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
                                 moq, branding_possible, delivery_note, ready_stock, under_production, status, gst_rate, is_addon)
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
      coalesce(nullif(v_row ->> 'status', ''), 'review')::public.product_status,
      coalesce(nullif(v_row ->> 'gst_rate', '')::numeric, 18),
      coalesce((v_row ->> 'is_addon')::boolean, false))
    on conflict (sku) do update set
      name = excluded.name, brand = excluded.brand, category_id = excluded.category_id,
      subcategory = excluded.subcategory, description = coalesce(excluded.description, p.description),
      features = excluded.features, specs = excluded.specs, colours = excluded.colours,
      image_path = coalesce(excluded.image_path, p.image_path), mrp = excluded.mrp,
      sell_price = coalesce(excluded.sell_price, p.sell_price),
      price_basis = excluded.price_basis, moq = excluded.moq,
      branding_possible = excluded.branding_possible, delivery_note = coalesce(excluded.delivery_note, p.delivery_note),
      ready_stock = excluded.ready_stock, under_production = excluded.under_production,
      status = excluded.status, gst_rate = excluded.gst_rate, is_addon = excluded.is_addon
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

    -- Supplier and cost columns are ignored: costs never pass through the app.

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

update public.catalogue_state set version = version + 1;

create or replace function public.tg_quote_item_gst()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.gst_rate is null and new.product_id is not null then
    select p.gst_rate into new.gst_rate from public.products p where p.id = new.product_id;
  end if;
  return new;
end;
$$;
revoke all on function public.tg_quote_item_gst() from public, anon, authenticated;
drop trigger if exists quote_item_gst on public.quote_items;
create trigger quote_item_gst before insert on public.quote_items
  for each row execute function public.tg_quote_item_gst();


-- Merging duplicates: offers move to the kept product and its price follows the cheapest cost.
create or replace function public.staff_merge_products(p_keep uuid, p_duplicate uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_staff() then
    raise exception 'Staff only' using errcode = '42501';
  end if;
  if p_keep = p_duplicate then
    raise exception 'Pick two different products' using errcode = '22023';
  end if;
  if not exists (select 1 from public.products where id = p_keep)
     or not exists (select 1 from public.products where id = p_duplicate) then
    raise exception 'Product not found' using errcode = 'P0002';
  end if;

  -- Move vendor offers; where both have the same vendor keep the cheaper cost.
  update public.vendor_offers k
     set cost_price = least(k.cost_price, d.cost_price)
    from public.vendor_offers d
   where k.product_id = p_keep and d.product_id = p_duplicate and d.vendor_id = k.vendor_id
     and d.cost_price is not null;
  update public.vendor_offers d
     set product_id = p_keep
   where d.product_id = p_duplicate
     and not exists (select 1 from public.vendor_offers k where k.product_id = p_keep and k.vendor_id = d.vendor_id);
  delete from public.vendor_offers where product_id = p_duplicate;

  -- Union colours and collections; keep the lower MRP. (Our price may be above MRP.)
  update public.products k
     set colours = (select coalesce(array_agg(distinct c), '{}') from unnest(k.colours || d.colours) c),
         mrp = case when k.mrp is null then d.mrp when d.mrp is null then k.mrp else least(k.mrp, d.mrp) end
    from public.products d
   where k.id = p_keep and d.id = p_duplicate;
  insert into public.product_collections (product_id, collection_id)
  select p_keep, collection_id from public.product_collections where product_id = p_duplicate
  on conflict do nothing;

  update public.products set status = 'archived' where id = p_duplicate;
  update public.product_internal
     set notes = left(coalesce(notes || E'\n', '') || 'Merged into ' || (select sku from public.products where id = p_keep), 2000)
   where product_id = p_duplicate;
end;
$$;

