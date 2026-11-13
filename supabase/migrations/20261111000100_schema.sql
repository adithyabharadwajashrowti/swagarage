-- Swagarage marketplace: core schema
-- Conventions:
--   * Every table has RLS enabled in the next migration. Nothing is readable or
--     writable by default.
--   * Data clients must never see (vendor names, costs, sources, internal notes)
--     lives in separate staff-only tables, never in a column of a public table.
--   * Money is numeric(12,2) in INR. Quantities are integers.

-- gen_random_uuid() is built into PostgreSQL 13+; no extensions needed.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.user_role as enum ('client', 'staff', 'admin');
create type public.product_status as enum ('draft', 'review', 'live', 'archived');
create type public.price_basis as enum ('mrp', 'gst_extra', 'on_request');
create type public.proofread_status as enum ('unchecked', 'ok', 'fixed', 'remove');
create type public.quote_status as enum ('submitted', 'in_review', 'quoted', 'won', 'lost', 'cancelled');

-- ---------------------------------------------------------------------------
-- Shared trigger: updated_at
-- ---------------------------------------------------------------------------
create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Profiles (one per auth user)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text check (email = lower(email)),
  full_name   text check (char_length(full_name) <= 120),
  company     text check (char_length(company) <= 160),
  phone       text check (phone ~ '^[0-9+() -]{6,20}$'),
  role        public.user_role not null default 'client',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------
create table public.categories (
  id          smallint generated always as identity primary key,
  slug        text not null unique check (slug ~ '^[a-z0-9-]{2,60}$'),
  name        text not null check (char_length(name) between 2 and 60),
  sort_order  smallint not null default 0
);

create table public.collections (
  id          smallint generated always as identity primary key,
  slug        text not null unique check (slug ~ '^[a-z0-9-]{2,60}$'),
  name        text not null check (char_length(name) between 2 and 60),
  description text check (char_length(description) <= 200),
  sort_order  smallint not null default 0
);

create table public.products (
  id                uuid primary key default gen_random_uuid(),
  sku               text not null unique check (sku ~ '^[a-z0-9-]{2,40}$'),
  slug              text not null unique check (slug ~ '^[a-z0-9-]{2,120}$'),
  name              text not null check (char_length(name) between 2 and 160),
  brand             text check (char_length(brand) <= 80),
  category_id       smallint not null references public.categories (id),
  subcategory       text check (char_length(subcategory) <= 80),
  description       text check (char_length(description) <= 2000),
  features          text[] not null default '{}' check (cardinality(features) <= 12),
  specs             jsonb not null default '{}'::jsonb check (jsonb_typeof(specs) = 'object'),
  colours           text[] not null default '{}' check (cardinality(colours) <= 20),
  image_path        text check (image_path ~ '^[A-Za-z0-9/_.-]{1,200}$'),
  mrp               numeric(12,2) check (mrp >= 0),
  sell_price        numeric(12,2) check (sell_price >= 0),
  price_basis       public.price_basis not null default 'on_request',
  moq               integer not null default 25 check (moq between 1 and 100000),
  branding_possible boolean not null default true,
  delivery_note     text check (char_length(delivery_note) <= 200),
  ready_stock       integer check (ready_stock >= 0),
  under_production  boolean not null default false,
  status            public.product_status not null default 'draft',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- A product sold to clients must never be priced above its printed MRP.
  constraint sell_price_within_mrp check (sell_price is null or mrp is null or sell_price <= mrp)
);
create index products_status_idx on public.products (status);
create index products_category_idx on public.products (category_id);
create trigger products_updated_at before update on public.products
  for each row execute function public.tg_set_updated_at();

create table public.product_collections (
  product_id    uuid not null references public.products (id) on delete cascade,
  collection_id smallint not null references public.collections (id) on delete cascade,
  primary key (product_id, collection_id)
);
create index product_collections_collection_idx on public.product_collections (collection_id);

-- ---------------------------------------------------------------------------
-- Internal (staff-only) data
-- ---------------------------------------------------------------------------
create table public.vendors (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique check (char_length(name) between 2 and 120),
  contact_name  text check (char_length(contact_name) <= 120),
  phone         text check (char_length(phone) <= 30),
  email         text check (char_length(email) <= 254),
  notes         text check (char_length(notes) <= 2000),
  created_at    timestamptz not null default now()
);

create table public.product_internal (
  product_id       uuid primary key references public.products (id) on delete cascade,
  source_ref       text check (char_length(source_ref) <= 200),
  data_origin      text check (char_length(data_origin) <= 300),
  proofread_status public.proofread_status not null default 'unchecked',
  notes            text check (char_length(notes) <= 2000),
  updated_at       timestamptz not null default now()
);
create trigger product_internal_updated_at before update on public.product_internal
  for each row execute function public.tg_set_updated_at();

create table public.vendor_offers (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references public.products (id) on delete cascade,
  vendor_id    uuid not null references public.vendors (id) on delete restrict,
  vendor_sku   text check (char_length(vendor_sku) <= 60),
  cost_price   numeric(12,2) check (cost_price >= 0),
  vendor_mrp   numeric(12,2) check (vendor_mrp >= 0),
  vendor_moq   integer check (vendor_moq >= 1),
  stock        jsonb not null default '{}'::jsonb check (jsonb_typeof(stock) = 'object'),
  last_checked date,
  created_at   timestamptz not null default now(),
  unique (product_id, vendor_id)
);
create index vendor_offers_vendor_idx on public.vendor_offers (vendor_id);

create table public.pricing_rules (
  category_id smallint primary key references public.categories (id) on delete cascade,
  margin_pct  numeric(5,2) not null check (margin_pct between 0 and 500),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Quotes
-- ---------------------------------------------------------------------------
create sequence public.quote_ref_seq;

create table public.quotes (
  id             uuid primary key default gen_random_uuid(),
  ref            text not null unique,
  user_id        uuid not null references public.profiles (id) on delete restrict,
  status         public.quote_status not null default 'submitted',
  contact_name   text not null check (char_length(contact_name) between 2 and 120),
  company        text not null check (char_length(company) between 2 and 160),
  email          text not null check (char_length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone          text check (phone ~ '^[0-9+() -]{6,20}$'),
  occasion       text check (char_length(occasion) <= 120),
  delivery_city  text check (char_length(delivery_city) <= 80),
  needed_by      date,
  notes          text check (char_length(notes) <= 2000),
  estimate_total numeric(20,2) not null default 0 check (estimate_total >= 0),
  quoted_total   numeric(20,2) check (quoted_total >= 0),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index quotes_user_idx on public.quotes (user_id, created_at desc);
create index quotes_status_idx on public.quotes (status, created_at desc);
create trigger quotes_updated_at before update on public.quotes
  for each row execute function public.tg_set_updated_at();

create table public.quote_items (
  id           uuid primary key default gen_random_uuid(),
  quote_id     uuid not null references public.quotes (id) on delete cascade,
  product_id   uuid references public.products (id) on delete set null,
  product_sku  text not null,
  product_name text not null,
  quantity     integer not null check (quantity between 1 and 100000),
  unit_price   numeric(12,2),
  price_basis  public.price_basis not null,
  colour       text check (char_length(colour) <= 60),
  branding     text check (char_length(branding) <= 200)
);
create index quote_items_quote_idx on public.quote_items (quote_id);

create table public.quote_events (
  id          bigint generated always as identity primary key,
  quote_id    uuid not null references public.quotes (id) on delete cascade,
  actor_id    uuid references public.profiles (id) on delete set null,
  from_status public.quote_status,
  to_status   public.quote_status not null,
  message     text check (char_length(message) <= 1000),
  created_at  timestamptz not null default now()
);
create index quote_events_quote_idx on public.quote_events (quote_id, created_at);

-- Staff-only notes on a quote, kept out of the client-visible quotes table.
create table public.quote_internal (
  quote_id   uuid primary key references public.quotes (id) on delete cascade,
  notes      text check (char_length(notes) <= 4000),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Gift assistant log (lead signal; authenticated users only)
-- ---------------------------------------------------------------------------
create table public.assistant_requests (
  id          bigint generated always as identity primary key,
  user_id     uuid references public.profiles (id) on delete set null,
  query       text not null check (char_length(query) between 1 and 500),
  product_ids uuid[] not null default '{}' check (cardinality(product_ids) <= 30),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Audit log (written only by triggers)
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id         bigint generated always as identity primary key,
  actor_id   uuid,
  action     text not null,
  table_name text not null,
  row_id     text,
  old_data   jsonb,
  new_data   jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_created_idx on public.audit_log (created_at desc);
