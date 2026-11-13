-- Attack suite: things a hostile visitor, client or staff member might try.
-- Runs after 10_security_tests.sql (same fixtures). Each block raises FAIL on a hole.
\set ON_ERROR_STOP on

-- ---------- anonymous ----------
begin;
select test.login('anon'); set local role anon;
do $$ declare ok boolean; begin
  -- 1. Pull vendor costs through a join/sub-select (PostgREST embedding does the same)
  ok := false; begin perform (select json_agg(v) from public.vendor_offers v where v.product_id = p.id) from public.products p;
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL anon: vendor costs via embed'; end if;
  -- 2. Read internal tables through the catalogue snapshot function
  if (select public.get_catalogue()::text) ~* 'cost_price|vendor|source_ref|data_origin|Hidden Vendor|catalogue p\.' then
    raise exception 'FAIL anon: snapshot leaks internal data'; end if;
  if (select public.get_catalogue()::text) ~ 'Secret Draft' then raise exception 'FAIL anon: snapshot leaks drafts'; end if;
  -- 3. Call internal/staff functions
  ok := false; begin perform public.is_backend(); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL anon: is_backend callable'; end if;
  ok := false; begin perform public.staff_merge_products(gen_random_uuid(), gen_random_uuid()); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL anon: merge callable'; end if;
  ok := false; begin perform public.log_assistant_request('x', '{}'); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL anon: assistant log callable'; end if;
  -- 4. Write to storage
  ok := false; begin insert into storage.objects (bucket_id, name) values ('product-images', 'x.jpg'); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL anon: storage upload'; end if;
  ok := false; begin insert into storage.objects (bucket_id, name) values ('catalogue', 'v999999.json'); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL anon: poisoned catalogue upload'; end if;
end $$;
rollback;

-- ---------- signed-in client ----------
begin;
select test.login('client2'); set local role authenticated;
do $$ declare ok boolean; v_live uuid; begin
  select id into v_live from public.products where sku = 'live-1';
  -- 5. Trigger functions called directly
  ok := false; begin perform public.tg_audit(); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL client: trigger function callable'; end if;
  -- 6. Direct writes to logs and quote children
  ok := false; begin insert into public.audit_log (action, table_name) values ('x', 'y'); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL client: audit insert'; end if;
  ok := false; begin insert into public.quote_events (quote_id, to_status) select id, 'won' from public.quotes limit 1;
    if not found then ok := true; end if; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL client: event insert'; end if;
  ok := false; begin insert into public.assistant_requests (query) values ('spam'); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL client: assistant log insert'; end if;
  -- 7. Change own email or id (account takeover helpers)
  ok := false; begin update public.profiles set email = 'admin@swagarage.test' where id = auth.uid(); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL client: changed email'; end if;
  -- 8. Huge numbers: must fail cleanly (22023/22003) not succeed
  ok := false; begin perform public.submit_quote(jsonb_build_object('contact_name','Client','company','Acme','email','c2@company.test',
      'items', jsonb_build_array(jsonb_build_object('product_id', v_live, 'quantity', 999999999))));
  exception when sqlstate '22023' or sqlstate '22003' then ok := true; end;
  if not ok then raise exception 'FAIL client: absurd quantity accepted'; end if;
  ok := false; begin perform public.submit_quote(jsonb_build_object('contact_name','Client','company','Acme','email','c2@company.test',
      'items', jsonb_build_array(jsonb_build_object('product_id', v_live, 'quantity', -5))));
  exception when sqlstate '22023' then ok := true; end;
  if not ok then raise exception 'FAIL client: negative quantity'; end if;
  -- 9. Malformed payloads
  ok := false; begin perform public.submit_quote('[1,2,3]'); exception when sqlstate '22023' then ok := true; end;
  if not ok then raise exception 'FAIL client: array payload'; end if;
  ok := false; begin perform public.submit_quote(jsonb_build_object('contact_name','Client','company','Acme','email','c2@company.test',
      'items', (select jsonb_agg(jsonb_build_object('product_id', v_live, 'quantity', 30, 'colour', g::text)) from generate_series(1, 51) g)));
  exception when sqlstate '22023' then ok := true; end;
  if not ok then raise exception 'FAIL client: 51 lines accepted'; end if;
  ok := false; begin perform public.submit_quote(jsonb_build_object('contact_name','Client','company','Acme','email','c2@company.test','needed_by','2001-01-01',
      'items', jsonb_build_array(jsonb_build_object('product_id', v_live, 'quantity', 30))));
  exception when sqlstate '22023' then ok := true; end;
  if not ok then raise exception 'FAIL client: past date accepted'; end if;
  -- 10. Script injection is stored as text, never executed; check it round-trips unchanged
  perform public.submit_quote(jsonb_build_object('contact_name','<script>alert(1)</script>','company','Acme''); drop table public.products; --',
      'email','c2@company.test','items', jsonb_build_array(jsonb_build_object('product_id', v_live, 'quantity', 30))));
  if not exists (select 1 from public.products) then raise exception 'FAIL client: SQL injection'; end if;
  -- 10b. Client poisoning the CDN catalogue with fake prices
  ok := false; begin insert into storage.objects (bucket_id, name) values ('catalogue', 'v999999.json'); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL client: poisoned catalogue upload'; end if;
  -- 11. Merge / snapshot internals
  ok := false; begin perform public.staff_merge_products(v_live, v_live); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL client: merge allowed'; end if;
end $$;
rollback;

-- ---------- staff ----------
begin;
select test.login('staff'); set local role authenticated;
do $$ declare ok boolean; begin
  -- 12. Staff tampering with the audit trail
  ok := false; begin delete from public.audit_log; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL staff: deleted audit log'; end if;
  ok := false; begin update public.audit_log set action = 'x'; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL staff: edited audit log'; end if;
  -- 13. Staff granting themselves admin through any path
  ok := false; begin update public.profiles set role = 'admin' where id = auth.uid(); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL staff: self-promotion'; end if;
  -- 14. Staff editing a client's profile
  ok := false; begin update public.profiles set full_name = 'hacked' where email = 'client2@company.test';
    if not found then ok := true; end if; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL staff: edited client profile'; end if;
end $$;
rollback;

\echo 'ALL ATTACK TESTS PASSED'
