-- Allow-list check: fails if any table or function becomes reachable by the
-- API roles beyond what is intended. Update the lists here deliberately.
\set ON_ERROR_STOP on
do $$ declare bad text; begin
  select string_agg(p.proname, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
     and p.proname not in ('is_staff', 'is_admin', 'current_user_role', 'catalogue_version', 'get_catalogue');
  if bad is not null then raise exception 'FAIL: anon can execute %', bad; end if;

  select string_agg(p.proname, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')
     and p.proname not in ('is_staff', 'is_admin', 'current_user_role', 'catalogue_version', 'get_catalogue',
       'submit_quote', 'cancel_my_quote', 'staff_update_quote', 'admin_set_role', 'log_assistant_request',
       'recompute_sell_prices', 'staff_import_products', 'staff_merge_products');
  if bad is not null then raise exception 'FAIL: authenticated can execute %', bad; end if;

  select string_agg(c.relname || ':' || priv, ', ') into bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join unnest(array['SELECT','INSERT','UPDATE','DELETE']) priv
   where n.nspname = 'public' and c.relkind in ('r', 'v', 'm')
     and has_table_privilege('anon', c.oid, priv)
     and not (priv = 'SELECT' and c.relname in ('categories', 'collections', 'product_collections', 'products'));
  if bad is not null then raise exception 'FAIL: anon has %', bad; end if;

  select string_agg(c.relname, ', ') into bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if bad is not null then raise exception 'FAIL: RLS disabled on %', bad; end if;

  select string_agg(p.proname, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%');
  if bad is not null then raise exception 'FAIL: SECURITY DEFINER without search_path: %', bad; end if;
end $$;
\echo 'PRIVILEGE INVENTORY OK'
