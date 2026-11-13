-- First visit: anonymous visitor downloads the catalogue snapshot (all 5,000 products in one document)
begin;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select public.get_catalogue();
commit;
