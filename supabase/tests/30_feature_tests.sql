-- Feature tests for catalogue snapshot, merge and logo rule.
\set ON_ERROR_STOP on
begin;
-- Suppliers and costs are loaded by the database owner (staff cannot touch them).
insert into public.products (sku, slug, name, category_id, mrp, colours, status)
  values ('dup-a', 'dup-a', 'Steel Bottle', 1, 900, '{Black}', 'live'), ('dup-b', 'dup-b', 'Steel Bottle 500ml', 1, 850, '{Blue,Black}', 'live');
insert into public.markup_slabs (up_to, inclusive, factor) values (1000, true, 1.10), (null, true, 1.05);
insert into public.vendors (name) values ('Vendor A'), ('Vendor B');
insert into public.vendor_offers (product_id, vendor_id, cost_price) select p.id, v.id, 500 from public.products p, public.vendors v where p.sku = 'dup-a' and v.name = 'Vendor A';
insert into public.vendor_offers (product_id, vendor_id, cost_price) select p.id, v.id, 420 from public.products p, public.vendors v where p.sku = 'dup-b' and v.name = 'Vendor B';
insert into public.vendor_offers (product_id, vendor_id, cost_price) select p.id, v.id, 480 from public.products p, public.vendors v where p.sku = 'dup-b' and v.name = 'Vendor A';
select test.login('staff'); set local role authenticated;
do $$ declare v_keep uuid; v_dup uuid; v0 bigint; v1 bigint; snap jsonb; ok boolean; begin
  -- snapshot rebuilds after a change and only contains live products
  v0 := public.catalogue_version();
  snap := public.get_catalogue()::jsonb;
  if (snap->>'version')::bigint <> v0 then raise exception 'FAIL snapshot: version mismatch'; end if;
  update public.products set status = 'live' where sku = 'draft-1';
  v1 := public.catalogue_version();
  if v1 <= v0 then raise exception 'FAIL snapshot: version not bumped'; end if;
  snap := public.get_catalogue()::jsonb;
  if not (snap::text ~ 'Secret Draft') then raise exception 'FAIL snapshot: not rebuilt'; end if;
  if jsonb_array_length(snap->'products') <> (select count(*) from public.products where status = 'live') then
    raise exception 'FAIL snapshot: product count'; end if;
  if public.catalogue_version() <> v1 then raise exception 'FAIL snapshot: rebuild bumped version'; end if;

  -- merge: two listings of the same bottle from two vendors
  select id into v_keep from public.products where sku = 'dup-a';
  select id into v_dup from public.products where sku = 'dup-b';
  perform public.staff_merge_products(v_keep, v_dup);
  if (select status from public.products where id = v_dup) <> 'archived' then raise exception 'FAIL merge: duplicate not archived'; end if;
  if (select mrp from public.products where id = v_keep) <> 850 then raise exception 'FAIL merge: lower MRP not kept'; end if;
  if not (select colours @> '{Blue,Black}' from public.products where id = v_keep) then raise exception 'FAIL merge: colours'; end if;
  begin perform public.staff_merge_products(v_keep, v_keep); raise exception 'FAIL merge: self-merge allowed';
  exception when sqlstate '22023' then null; end;

  -- staff may publish only versioned JSON files to the catalogue bucket
  insert into storage.objects (bucket_id, name) values ('catalogue', 'v' || v1 || '.json');
  ok := false; begin insert into storage.objects (bucket_id, name) values ('catalogue', 'evil.html'); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL storage: arbitrary file in catalogue bucket'; end if;
  -- logo rule set through the sheet import
  perform public.staff_import_products(jsonb_build_array(jsonb_build_object('sku','dup-a','name','Steel Bottle','category','Bags & Backpacks','logo_action','replace')));
  if (select logo_action from public.product_internal pi join public.products p on p.id = pi.product_id where p.sku = 'dup-a') <> 'replace' then
    raise exception 'FAIL import: logo rule'; end if;
end $$;
reset role;
do $$ declare v_keep uuid := (select id from public.products where sku = 'dup-a'); begin
  if (select count(*) from public.vendor_offers where product_id = v_keep) <> 2 then raise exception 'FAIL merge: offers not moved'; end if;
  if (select cost_price from public.vendor_offers vo join public.vendors v on v.id = vo.vendor_id where product_id = v_keep and v.name = 'Vendor A') <> 480 then
    raise exception 'FAIL merge: cheaper cost not kept'; end if;
  -- price follows the cheapest cost: 420 x 1.10 (test slab) = 462
  if (select sell_price from public.products where id = v_keep) <> 462 then raise exception 'FAIL merge: price not from cheapest cost'; end if;
end $$;
rollback;
begin;
select test.login('client1'); set local role authenticated;
do $$ begin
  if exists (select 1 from public.catalogue_state) then raise exception 'FAIL client: reads catalogue_state'; end if;
exception when insufficient_privilege then null; end $$;
rollback;
\echo 'ALL FEATURE TESTS PASSED'
