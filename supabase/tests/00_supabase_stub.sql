-- Test-only: recreates the parts of a Supabase database the migrations rely
-- on, so the migrations and security tests can run on plain PostgreSQL.
-- Never run this against a real Supabase project.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role authenticator noinherit login;
grant anon, authenticated, service_role to authenticator;

grant usage on schema public to anon, authenticated, service_role;
-- Supabase's default: everything in public is granted to the API roles.
-- The migrations must undo this; the tests prove they do.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub', '')::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.buckets (
  id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
  name text, owner uuid);
alter table storage.objects enable row level security;
grant select, insert, update, delete on storage.objects to anon, authenticated;
create policy public_read on storage.objects for select using (true);
