-- Scale + operations:
--   * Catalogue snapshot: the storefront loads ONE precomputed JSON document
--     instead of thousands of rows with joins. Rebuilt lazily after any
--     catalogue change. Clients check a tiny version number first and reuse
--     their cached copy when nothing changed.
--   * Merge duplicate products (same item from two vendors): keep one listing,
--     move every vendor offer onto it, archive the duplicate.
--   * Logo rule per product (keep brand logo / replace with Swagarage / none).
--   * Extra indexes for foreign keys and rate-limit lookups.

-- ---------------------------------------------------------------------------
-- Catalogue snapshot
-- ---------------------------------------------------------------------------
create table public.catalogue_state (
  id       smallint primary key default 1 check (id = 1),
  version  bigint not null default 1,
  built    bigint not null default 0,
  payload  json,
  built_at timestamptz
);
insert into public.catalogue_state (id) values (1);
alter table public.catalogue_state enable row level security;   -- no policies: functions only
revoke all on table public.catalogue_state from anon, authenticated;

create or replace function public.tg_catalogue_dirty()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.catalogue_state set version = version + 1 where id = 1;
  return null;
end;
$$;

create trigger catalogue_dirty_products after insert or update or delete on public.products
  for each statement execute function public.tg_catalogue_dirty();
create trigger catalogue_dirty_product_collections after insert or update or delete on public.product_collections
  for each statement execute function public.tg_catalogue_dirty();
create trigger catalogue_dirty_categories after insert or update or delete on public.categories
  for each statement execute function public.tg_catalogue_dirty();
create trigger catalogue_dirty_collections after insert or update or delete on public.collections
  for each statement execute function public.tg_catalogue_dirty();

create or replace function public.catalogue_version()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select version from public.catalogue_state where id = 1;
$$;

-- Builds the public catalogue: live products only, public columns only.
create or replace function public.build_catalogue_payload(p_version bigint)
returns json
language sql
stable
security definer
set search_path = ''
as $$
  -- Stored as json (plain text) so serving it is a copy, not a re-serialisation.
  select jsonb_build_object(
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
        'colours', p.colours, 'image_path', p.image_path, 'mrp', p.mrp, 'sell_price', p.sell_price,
        'price_basis', p.price_basis, 'moq', p.moq, 'branding_possible', p.branding_possible,
        'delivery_note', p.delivery_note, 'ready_stock', p.ready_stock, 'under_production', p.under_production,
        'status', p.status, 'updated_at', p.updated_at,
        'category', jsonb_build_object('id', c.id, 'slug', c.slug, 'name', c.name),
        'collection_slugs', coalesce((select jsonb_agg(co.slug) from public.product_collections pc
                                        join public.collections co on co.id = pc.collection_id
                                       where pc.product_id = p.id), '[]'))
        order by p.name)
      from public.products p join public.categories c on c.id = p.category_id
      where p.status = 'live'), '[]'))::json;
$$;

-- Returns the snapshot, rebuilding it once if the catalogue changed.
-- Concurrent callers wait on one rebuild instead of all rebuilding.
create or replace function public.get_catalogue()
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  st public.catalogue_state%rowtype;
begin
  select * into st from public.catalogue_state where id = 1;
  if st.built = st.version and st.payload is not null then
    return st.payload;
  end if;
  perform pg_advisory_xact_lock(hashtext('build_catalogue'));
  select * into st from public.catalogue_state where id = 1;
  if st.built = st.version and st.payload is not null then
    return st.payload;
  end if;
  st.payload := public.build_catalogue_payload(st.version);
  -- Write without bumping the version (this table has no dirty trigger).
  update public.catalogue_state set payload = st.payload, built = st.version, built_at = now() where id = 1;
  return st.payload;
end;
$$;

revoke all on function public.catalogue_version(), public.get_catalogue(), public.build_catalogue_payload(bigint),
  public.tg_catalogue_dirty() from public, anon, authenticated;
grant execute on function public.catalogue_version(), public.get_catalogue() to anon, authenticated;

-- CDN copy: staff browsers publish each snapshot version as an immutable file
-- catalogue/v<version>.json in this public bucket; visitors read it from the
-- CDN and only fall back to get_catalogue() if that version isn't there yet.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('catalogue', 'catalogue', true, 20971520, array['application/json'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
create policy catalogue_staff_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'catalogue' and (select public.is_staff()) and name ~ '^v[0-9]+\.json$');

-- ---------------------------------------------------------------------------
-- Logo rule
-- ---------------------------------------------------------------------------
create type public.logo_action as enum ('keep', 'replace', 'none');
alter table public.product_internal add column logo_action public.logo_action not null default 'keep';

-- ---------------------------------------------------------------------------
-- Merge duplicates
-- ---------------------------------------------------------------------------
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

  -- Union colours and collections; keep the lower MRP.
  update public.products k
     set colours = (select coalesce(array_agg(distinct c), '{}') from unnest(k.colours || d.colours) c),
         mrp = case when k.mrp is null then d.mrp when d.mrp is null then k.mrp else least(k.mrp, d.mrp) end,
         sell_price = case when k.sell_price is not null and d.mrp is not null and k.sell_price > least(coalesce(k.mrp, d.mrp), d.mrp)
                           then least(coalesce(k.mrp, d.mrp), d.mrp) else k.sell_price end
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
revoke all on function public.staff_merge_products(uuid, uuid) from public, anon, authenticated;
grant execute on function public.staff_merge_products(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Indexes for foreign keys and per-user lookups
-- ---------------------------------------------------------------------------
create index if not exists assistant_requests_user_idx on public.assistant_requests (user_id, created_at desc);
create index if not exists quote_items_product_idx on public.quote_items (product_id);
create index if not exists quote_events_actor_idx on public.quote_events (actor_id);
create index if not exists vendor_offers_product_idx on public.vendor_offers (product_id);
create index if not exists products_name_idx on public.products (name);
create index if not exists audit_log_actor_idx on public.audit_log (actor_id);
create index if not exists profiles_role_idx on public.profiles (role) where role <> 'client';

