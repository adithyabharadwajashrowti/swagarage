-- Signed-in client opens their account page
\set u random(1, 3000)
begin;
select set_config('request.jwt.claims', json_build_object('sub', (select id from bench.users where n = :u), 'role', 'authenticated')::text, true);
set local role authenticated;
select * from public.quotes where user_id = auth.uid() order by created_at desc;
commit;
