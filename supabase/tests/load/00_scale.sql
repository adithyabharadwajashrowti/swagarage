-- Load-test fixtures: scale the catalogue to 5,000 live products (2.5x the
-- 2,000 target) and create 3,000 client accounts.
insert into public.vendors (name) values ('Bench Vendor') on conflict do nothing;
insert into public.products (sku, slug, name, brand, category_id, subcategory, features, specs, colours,
  image_path, mrp, price_basis, moq, status)
select 'bench-' || g, 'bench-product-' || g, 'Bench Product ' || g, 'Brand ' || (g % 40),
  (g % 6) + 1, 'Sub ' || (g % 25),
  array['Feature one for ' || g, 'Feature two', 'Feature three'],
  jsonb_build_object('Dimensions', 'H 40 cm x L 30 cm', 'Material', 'Polyester', 'Weight', (g % 900) || ' g'),
  array['Black', 'Navy', 'Grey'], 'seed/obl-04.jpg', 200 + (g % 9000), 'mrp', 25, 'live'
from generate_series(1, 4865) g;
update public.products set status = 'live';
insert into public.product_collections (product_id, collection_id)
select id, (abs(hashtext(id::text)) % 6) + 1 from public.products on conflict do nothing;
insert into public.product_internal (product_id) select id from public.products on conflict do nothing;
insert into public.vendor_offers (product_id, vendor_id, cost_price)
select p.id, v.id, round(p.mrp * 0.55) from public.products p, public.vendors v where v.name = 'Bench Vendor'
on conflict do nothing;

create schema if not exists bench;
create table bench.users (n int primary key, id uuid not null);
insert into auth.users (email) select 'client' || g || '@bench.test' from generate_series(1, 3000) g;
insert into bench.users select row_number() over (order by email)::int, id from auth.users where email like '%@bench.test';
grant usage on schema bench to anon, authenticated;
grant select on bench.users to authenticated, anon;

-- Invoker wrapper so a rate-limited submit doesn't abort a pgbench client.
create function bench.submit(p_offset int) returns int language plpgsql as $$
begin
  perform public.submit_quote(jsonb_build_object(
    'contact_name', 'Bench Client', 'company', 'Bench Co', 'email', 'bench@bench.test',
    'items', (select jsonb_agg(jsonb_build_object('product_id', id, 'quantity', 30))
                from (select id from public.products where status = 'live' order by sku offset p_offset limit 3) s)));
  return 1;
exception when sqlstate '54000' then
  return 0;
end $$;
grant execute on function bench.submit(int) to authenticated;
analyze;
