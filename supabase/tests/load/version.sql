-- Repeat visit: check the catalogue version, reuse the browser's cached copy
begin;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select public.catalogue_version();
commit;
