-- Visitor opens a product page by slug
\set g random(1, 4865)
begin;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select * from public.products where slug = 'bench-product-' || :g and status = 'live';
commit;
