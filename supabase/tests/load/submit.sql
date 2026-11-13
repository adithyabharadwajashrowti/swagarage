-- Signed-in client submits a 3-line quote
\set u random(1, 3000)
\set o random(0, 4990)
begin;
select set_config('request.jwt.claims', json_build_object('sub', (select id from bench.users where n = :u), 'role', 'authenticated')::text, true);
set local role authenticated;
select bench.submit(:o);
commit;
