-- One row per property (subdomain). For v1 we keep the editable content
-- and the rendered site as JSON blobs — simple and works immediately.
-- When you need to query availability with SQL, split into the normalized
-- tables described in BACKEND-GUIDE.md (units, availability_blocks, ...).

create extension if not exists pgcrypto;

create table if not exists properties (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  admin_state jsonb not null,   -- {property, pricing, units} — what the admin edits
  site        jsonb not null,   -- transformed PROPERTY — what the public site renders
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- Reservation requests submitted from the public site's booking form.
create table if not exists booking_requests (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null,
  name        text,
  phone       text,
  email       text,
  checkin     date,
  checkout    date,
  adults      int default 0,
  children    int default 0,
  infants     int default 0,
  pets        int default 0,
  rooms       jsonb default '[]'::jsonb,
  message     text,
  status      text default 'nou',
  created_at  timestamptz default now()
);
create index if not exists booking_requests_slug_idx on booking_requests(slug, created_at desc);
