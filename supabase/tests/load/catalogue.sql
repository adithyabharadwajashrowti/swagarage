-- Anonymous visitor loads the catalogue page (what PostgREST runs for the app's query, 1000 rows/page)
\set page random(0, 4)
begin;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select p.id, p.sku, p.slug, p.name, p.brand, p.category_id, p.subcategory, p.features, p.specs, p.colours,
       p.image_path, p.mrp, p.sell_price, p.price_basis, p.moq, p.ready_stock, p.status,
       (select row_to_json(c) from (select c.id, c.slug, c.name from public.categories c where c.id = p.category_id) c) as category,
       coalesce((select json_agg(json_build_object('collection', json_build_object('slug', co.slug)))
                   from public.product_collections pc join public.collections co on co.id = pc.collection_id
                  where pc.product_id = p.id), '[]') as product_collections
  from public.products p
 where p.status = 'live'
 order by p.name
 limit 1000 offset :page * 1000;
commit;
