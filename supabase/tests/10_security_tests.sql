-- Security tests. Run after the stub and all migrations (see scripts/test-db.sh).
-- Each block raises an exception starting with FAIL if a rule is broken.
\set ON_ERROR_STOP on

-- ---------- fixtures (as superuser) ----------
create schema test;
create table test.users (name text primary key, id uuid not null);
create function test.login(p_name text) returns void language plpgsql as $$
begin
  if p_name = 'anon' then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', (select id from test.users where name = p_name), 'role', 'authenticated')::text, true);
  end if;
end $$;
grant usage on schema test to anon, authenticated;
grant select on test.users to anon, authenticated;

-- Sign-ups: one tries to smuggle a role through metadata.
insert into auth.users (email, raw_user_meta_data) values
  ('admin@swagarage.test',   '{"full_name":"Admin"}'),
  ('staff@swagarage.test',   '{"full_name":"Staff"}'),
  ('client1@company.test',   '{"full_name":"Client One","company":"Acme"}'),
  ('client2@company.test',   '{"full_name":"Client Two","role":"admin"}');
insert into test.users select split_part(email, '@', 1), id from auth.users;

update public.profiles set role = 'admin' where email = 'admin@swagarage.test';
update public.profiles set role = 'staff' where email = 'staff@swagarage.test';

insert into public.products (sku, slug, name, brand, category_id, mrp, sell_price, price_basis, moq, status)
values
  -- live-1 is repriced from its vendor cost by the test slabs below (400 x 1.10 = 440).
  ('live-1',  'live-1',  'Live Bottle',   'Acme', 1, 1000, 800,  'gst_extra', 25, 'live'),
  ('live-2',  'live-2',  'Live Speaker',  'Acme', 2, 3000, null, 'mrp',       25, 'live'),
  ('draft-1', 'draft-1', 'Secret Draft',  'Acme', 1, 500,  null, 'mrp',       25, 'draft');
-- Test slabs only (the real ones are private): up to 1,000 x1.10, above x1.05.
insert into public.markup_slabs (up_to, inclusive, factor) values (1000, true, 1.10), (null, true, 1.05);
insert into public.vendors (name) values ('Hidden Vendor');
insert into public.vendor_offers (product_id, vendor_id, cost_price)
select p.id, v.id, 400 from public.products p, public.vendors v where p.sku = 'live-1';
insert into public.product_internal (product_id, source_ref) select id, 'catalogue p.4' from public.products;

-- ---------- sign-up ----------
do $$ begin
  if (select count(*) from public.profiles) <> 4 then raise exception 'FAIL: profile not created per user'; end if;
  if (select role from public.profiles where email = 'client2@company.test') <> 'client' then
    raise exception 'FAIL: role taken from sign-up metadata'; end if;
end $$;

-- ---------- anonymous visitor ----------
begin;
select test.login('anon'); set local role anon;
do $$ declare ok boolean; begin
  if (select count(*) from public.products) <> 2 then raise exception 'FAIL anon: should see exactly 2 live products'; end if;
  if exists (select 1 from public.products where sku = 'draft-1') then raise exception 'FAIL anon: sees draft'; end if;

  ok := false; begin perform 1 from public.vendor_offers; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL anon: can read vendor_offers'; end if;
  ok := false; begin perform 1 from public.vendors; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL anon: can read vendors'; end if;
  ok := false; begin perform 1 from public.product_internal; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL anon: can read product_internal'; end if;
  ok := false; begin perform 1 from public.quotes; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL anon: can read quotes'; end if;
  ok := false; begin perform 1 from public.profiles; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL anon: can read profiles'; end if;
  ok := false; begin insert into public.products (sku, slug, name, category_id) values ('x1','x1','Hack',1);
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL anon: can insert products'; end if;
  ok := false; begin perform public.submit_quote('{"items":[]}'); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL anon: can call submit_quote'; end if;
end $$;
rollback;

-- ---------- client 1 ----------
begin;
select test.login('client1'); set local role authenticated;
do $$ declare ok boolean; v_ref text; v_id uuid; v_live1 uuid; v_live2 uuid; v_draft uuid; begin
  if (select count(*) from public.profiles) <> 1 then raise exception 'FAIL client: sees other profiles'; end if;
  update public.profiles set full_name = 'Client Uno' where id = auth.uid();
  if (select full_name from public.profiles where id = auth.uid()) <> 'Client Uno' then raise exception 'FAIL client: cannot edit own name'; end if;

  ok := false; begin update public.profiles set role = 'admin' where id = auth.uid();
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL client: escalated own role'; end if;

  ok := false; begin perform 1 from public.vendor_offers; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL client: can read vendor costs'; end if;
  ok := false; begin perform 1 from public.vendors; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL client: can read vendors'; end if;
  if (select count(*) from public.product_internal) <> 0 then raise exception 'FAIL client: sees internal data'; end if;
  if (select count(*) from public.audit_log) <> 0 then raise exception 'FAIL client: sees audit log'; end if;
  if exists (select 1 from public.products where sku = 'draft-1') then raise exception 'FAIL client: sees draft'; end if;

  ok := false; begin update public.products set sell_price = 1 where sku = 'live-1';
    if found then raise exception 'FAIL client: updated product'; end if; ok := true;
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL client: product update'; end if;
  if (select sell_price from public.products where sku = 'live-1') <> 440 then raise exception 'FAIL client: changed price'; end if;

  select id into v_live1 from public.products where sku = 'live-1';
  select id into v_live2 from public.products where sku = 'live-2';
  select id into v_draft from public.products p where sku = 'draft-1';  -- invisible, stays null

  -- valid quote: prices come from DB (client sends a fake price that must be ignored)
  select quote_id, quote_ref into v_id, v_ref from public.submit_quote(jsonb_build_object(
    'contact_name','Client One','company','Acme','email','c1@company.test',
    'items', jsonb_build_array(
      jsonb_build_object('product_id', v_live1, 'quantity', 30, 'unit_price', 1),
      jsonb_build_object('product_id', v_live2, 'quantity', 25))));
  if v_ref !~ '^SG-\d{4}-\d{5}$' then raise exception 'FAIL client: bad ref %', v_ref; end if;
  if (select estimate_total from public.quotes where id = v_id) <> 30*440 + 25*3000 then
    raise exception 'FAIL client: estimate not from DB prices'; end if;
  if (select count(*) from public.quote_items where quote_id = v_id) <> 2 then raise exception 'FAIL client: items missing'; end if;
  if (select count(*) from public.quote_events where quote_id = v_id) <> 1 then raise exception 'FAIL client: no event'; end if;

  ok := false; begin perform public.submit_quote(jsonb_build_object('contact_name','Client','company','Acme','email','c1@company.test',
    'items', jsonb_build_array(jsonb_build_object('product_id', v_live1, 'quantity', 10))));
  exception when sqlstate '22023' then ok := true; end;
  if not ok then raise exception 'FAIL client: MOQ not enforced'; end if;

  ok := false; begin perform public.submit_quote(jsonb_build_object('contact_name','Client','company','Acme','email','c1@company.test',
    'items', jsonb_build_array(jsonb_build_object('product_id', (select id from test.users limit 1), 'quantity', 30))));
  exception when sqlstate '22023' then ok := true; end;
  if not ok then raise exception 'FAIL client: unknown/draft product accepted'; end if;

  ok := false; begin perform public.submit_quote(jsonb_build_object('contact_name','Client','company','Acme','email','not-an-email',
    'items', jsonb_build_array(jsonb_build_object('product_id', v_live1, 'quantity', 30))));
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL client: bad email accepted'; end if;

  ok := false; begin insert into public.quotes (ref, user_id, contact_name, company, email)
    values ('SG-X', auth.uid(), 'Me', 'Acme', 'a@b.co');
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL client: direct quote insert'; end if;

  ok := false; begin update public.quotes set status = 'won' where id = v_id;
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL client: direct quote update'; end if;

  ok := false; begin perform public.staff_update_quote(v_id, 'won');
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL client: staff_update_quote allowed'; end if;

  ok := false; begin perform public.admin_set_role(auth.uid(), 'admin');
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL client: admin_set_role allowed'; end if;

  ok := false; begin perform public.recompute_sell_prices(); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL client: recompute allowed'; end if;
  ok := false; begin perform public.staff_import_products('[]'); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL client: import allowed'; end if;

  -- rate limit: 1 quote exists, 9 more allowed, the 11th fails
  for i in 1..9 loop
    perform public.submit_quote(jsonb_build_object('contact_name','Client','company','Acme','email','c1@company.test',
      'items', jsonb_build_array(jsonb_build_object('product_id', v_live1, 'quantity', 25))));
  end loop;
  ok := false; begin perform public.submit_quote(jsonb_build_object('contact_name','Client','company','Acme','email','c1@company.test',
    'items', jsonb_build_array(jsonb_build_object('product_id', v_live1, 'quantity', 25))));
  exception when sqlstate '54000' then ok := true; end;
  if not ok then raise exception 'FAIL client: no rate limit'; end if;

  perform public.cancel_my_quote(v_id);
  if (select status from public.quotes where id = v_id) <> 'cancelled' then raise exception 'FAIL client: cancel'; end if;
end $$;
commit;

-- ---------- client 2 cannot see client 1 ----------
begin;
select test.login('client2'); set local role authenticated;
do $$ declare ok boolean; begin
  if (select count(*) from public.quotes) <> 0 then raise exception 'FAIL client2: sees other quotes'; end if;
  if (select count(*) from public.quote_items) <> 0 then raise exception 'FAIL client2: sees other items'; end if;
  if (select count(*) from public.quote_events) <> 0 then raise exception 'FAIL client2: sees other events'; end if;
  ok := false;
  begin perform public.cancel_my_quote((select id from public.quotes limit 1)); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL client2: cancelled someone else''s quote'; end if;
end $$;
rollback;
-- (client2 above used the id from its own empty view; also check with the real id)
begin;
select test.login('client2'); set local role authenticated;
do $$ declare ok boolean := false; v_id uuid; begin
  reset role; select id into v_id from public.quotes order by created_at limit 1; set local role authenticated;
  begin perform public.cancel_my_quote(v_id); exception when sqlstate 'P0002' then ok := true; end;
  if not ok then raise exception 'FAIL client2: cancel other quote by id'; end if;
end $$;
rollback;

-- ---------- staff ----------
begin;
select test.login('staff'); set local role authenticated;
do $$ declare ok boolean; v_id uuid; begin
  if (select count(*) from public.products) <> 3 then raise exception 'FAIL staff: cannot see drafts'; end if;
  -- Suppliers, costs and pricing rules are closed to staff too.
  ok := false; begin perform 1 from public.vendor_offers; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL staff: can read vendor costs'; end if;
  ok := false; begin perform 1 from public.vendors; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL staff: can read vendors'; end if;
  ok := false; begin perform 1 from public.pricing_rules; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL staff: can read pricing rules'; end if;
  ok := false; begin insert into public.vendor_offers (product_id, vendor_id, cost_price) select id, (select id from public.products limit 1), 1 from public.products limit 1;
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL staff: can write vendor costs'; end if;
  ok := false; begin perform public.recompute_sell_prices(); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL staff: can run recompute_sell_prices'; end if;
  ok := false; begin perform 1 from public.markup_slabs; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL staff: can read markup slabs'; end if;
  ok := false; begin perform public.markup_price(100); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL staff: can call markup_price'; end if;
  update public.products set name = 'Live Bottle 2' where sku = 'live-1';
  if (select name from public.products where sku = 'live-1') <> 'Live Bottle 2' then raise exception 'FAIL staff: cannot edit'; end if;

  select id into v_id from public.quotes where status <> 'cancelled' order by created_at limit 1;
  perform public.staff_update_quote(v_id, 'quoted', 'Here is your price', 50000, 'client asked twice');
  if (select status from public.quotes where id = v_id) <> 'quoted' then raise exception 'FAIL staff: status'; end if;
  if (select notes from public.quote_internal where quote_id = v_id) <> 'client asked twice' then raise exception 'FAIL staff: notes'; end if;

  delete from public.products where sku = 'live-2';
  if not exists (select 1 from public.products where sku = 'live-2') then raise exception 'FAIL staff: deleted product (admin only)'; end if;
  if (select count(*) from public.audit_log) <> 0 then raise exception 'FAIL staff: sees audit log'; end if;

  ok := false; begin perform public.admin_set_role((select id from test.users where name = 'client1'), 'staff');
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL staff: can set roles'; end if;


  -- import
  if (select inserted from public.staff_import_products(jsonb_build_array(jsonb_build_object(
      'sku','imp-1','name','Imported Mug','category','Eco-Friendly','mrp','450','vendor','New Vendor',
      'cost_price','200','collections', jsonb_build_array('Eco-Friendly Gifts'), 'status','review')))) <> 1 then
    raise exception 'FAIL staff: import'; end if;
  if (select count(*) from public.product_collections pc join public.products p on p.id = pc.product_id where p.sku = 'imp-1') <> 1 then
    raise exception 'FAIL staff: import collections'; end if;

  -- storage: staff can upload
  insert into storage.objects (bucket_id, name) values ('product-images', 'products/x.jpg');
end $$;
commit;

-- ---------- pricing (database owner only) ----------
do $$ begin
  -- the import above must not have created a supplier or a cost
  if exists (select 1 from public.vendors where name = 'New Vendor') then raise exception 'FAIL import: wrote a supplier'; end if;
  if exists (select 1 from public.vendor_offers vo join public.products p on p.id = vo.product_id where p.sku = 'imp-1') then
    raise exception 'FAIL import: wrote a cost'; end if;
  -- slabs (test values): boundary inclusive, rounded to Rs 1
  if public.markup_price(99) <> 109 or public.markup_price(1000) <> 1100 or public.markup_price(1001) <> 1051 then
    raise exception 'FAIL markup slabs'; end if;
  -- cost 400 -> 440; a cheaper offer wins automatically
  perform public.recompute_sell_prices();
  if (select sell_price from public.products where sku = 'live-1') <> 440 then raise exception 'FAIL recompute value'; end if;
  insert into public.vendors (name) values ('Second Vendor');
  insert into public.vendor_offers (product_id, vendor_id, cost_price)
  select p.id, v.id, 300 from public.products p, public.vendors v where p.sku = 'live-1' and v.name = 'Second Vendor';
  if (select sell_price from public.products where sku = 'live-1') <> 330 then raise exception 'FAIL cheapest offer reprice'; end if;
  -- the public catalogue never carries cost or supplier
  if public.build_catalogue_payload(0)::text ~* 'cost|vendor|Second Vendor|Hidden Vendor' then raise exception 'FAIL catalogue leaks cost'; end if;
end $$;

-- client sees the staff message but not internal notes; cannot upload images
begin;
select test.login('client1'); set local role authenticated;
do $$ declare ok boolean := false; begin
  if not exists (select 1 from public.quote_events where message = 'Here is your price') then raise exception 'FAIL client: cannot see staff reply'; end if;
  if (select count(*) from public.quote_internal) <> 0 then raise exception 'FAIL client: sees internal notes'; end if;
  begin insert into storage.objects (bucket_id, name) values ('product-images', 'products/hack.jpg');
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL client: uploaded image'; end if;
end $$;
rollback;

-- ---------- admin ----------
begin;
select test.login('admin'); set local role authenticated;
do $$ declare ok boolean := false; begin
  if (select count(*) from public.audit_log where table_name = 'products' and action = 'UPDATE') < 1 then
    raise exception 'FAIL admin: audit log missing product updates'; end if;
  if (select actor_id from public.audit_log where table_name = 'products' and action = 'UPDATE' order by id limit 1)
     <> (select id from test.users where name = 'staff') then raise exception 'FAIL admin: audit actor wrong'; end if;
  perform public.admin_set_role((select id from test.users where name = 'client1'), 'staff');
  if (select role from public.profiles where email = 'client1@company.test') <> 'staff' then raise exception 'FAIL admin: set role'; end if;
  begin perform public.admin_set_role(auth.uid(), 'client'); exception when sqlstate '22023' then ok := true; end;
  if not ok then raise exception 'FAIL admin: last admin could demote self'; end if;
  delete from public.products where sku = 'draft-1';
  if exists (select 1 from public.products where sku = 'draft-1') then raise exception 'FAIL admin: cannot delete'; end if;
end $$;
rollback;

\echo 'ALL SECURITY TESTS PASSED'
