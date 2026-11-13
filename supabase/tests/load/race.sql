-- 30 simultaneous quote submissions from ONE client: at most 10 may succeed.
begin;
select set_config('request.jwt.claims', json_build_object('sub', (select id from test.users where name = 'client2'), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.submit_quote(jsonb_build_object('contact_name','Client','company','Acme','email','c2@company.test',
  'items', jsonb_build_array(jsonb_build_object('product_id', (select id from public.products where sku = 'live-1'), 'quantity', 30))));
commit;
