-- One row per property (subdomain). For v1 we keep the editable content
-- and the rendered site as JSON blobs — simple and works immediately.
-- When you need to query availability with SQL, split into the normalized
-- tables described in BACKEND-GUIDE.md (units, availability_blocks, ...).

create extension if not exists pgcrypto;

-- Login accounts. role = 'admin' (platform owner) or 'host' (hotelier).
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique not null,
  password_hash text not null,
  role          text not null default 'host',
  name          text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create table if not exists properties (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  admin_state jsonb not null,   -- {property, pricing, units} — what the admin edits
  site        jsonb not null,   -- transformed PROPERTY — what the public site renders
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- Which host owns each property (null = unassigned, admin-only). Added via ALTER so
-- it applies to existing databases too.
alter table properties add column if not exists owner_id uuid references users(id) on delete set null;
create index if not exists properties_owner_idx on properties(owner_id);

-- Unit approval workflow: the hotelier reviews the generated site and approves/rejects.
-- {status:'pending'|'approved'|'rejected', token, requestedAt, decidedAt, note}
alter table properties add column if not exists approval jsonb;

-- Offers / deals the hotelier creates (interval discounts, last-minute, perks, etc.).
-- Array of {id, type, title, active, ...type-specific fields...}
alter table properties add column if not exists deals jsonb default '[]'::jsonb;
-- The hotelier must agree that offers are published on the LocalStay platform.
alter table properties add column if not exists deals_consent boolean default false;

-- Password recovery: a short-lived reset token per user.
alter table users add column if not exists reset_token text;
alter table users add column if not exists reset_expires timestamptz;
alter table users add column if not exists photo_price numeric(8,2) default 3;
alter table users add column if not exists photo_spent numeric(10,2) default 0;
alter table users add column if not exists photos_optimized integer default 0;

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

-- Lightweight event tracking (e.g. phone number reveals on the public site).
create table if not exists site_events (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null,
  type       text not null,
  meta       jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
create index if not exists site_events_type_idx on site_events(type, created_at desc);
create index if not exists site_events_slug_idx on site_events(slug, created_at desc);

-- Facebook groups the hotelier wants to post to (per property). Used by the
-- Facebook module to generate a slightly different ready-to-post text per group.
create table if not exists fb_groups (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null,
  name       text not null,
  url        text default '',
  created_at timestamptz default now()
);
create index if not exists fb_groups_slug_idx on fb_groups(slug, created_at);

-- Calendar sync events (iCal import from Booking/Airbnb + export pulls of our
-- .ics). One row per event; the master admin aggregates these into average
-- sync intervals / per-hour rates per room (unit) per property.
create table if not exists sync_events (
  id         bigserial primary key,
  slug       text not null,
  unit_id    text not null,
  direction  text not null,          -- 'import' | 'export'
  status     text default 'ok',
  created_at timestamptz not null default now()
);
create index if not exists sync_events_lookup_idx on sync_events(slug, unit_id, direction, created_at desc);
create index if not exists sync_events_time_idx on sync_events(created_at desc);

-- Direct bookings: when the hotelier consents, tourists can book instantly (dates
-- get blocked) instead of only sending a request. kind='direct' marks those rows.
alter table booking_requests add column if not exists kind text default 'request';

-- Editable, per-property collaboration document (contract). Master admin edits the
-- content (optionally AI-generated), sends it to the hotelier, and it is signed on approval.
create table if not exists documents (
  id         uuid primary key default gen_random_uuid(),
  slug       text unique not null,
  title      text default 'Contract de colaborare',
  content    text default '',
  status     text default 'draft',        -- draft | sent | signed
  sent_at    timestamptz,
  updated_at timestamptz default now()
);
create index if not exists documents_slug_idx on documents(slug);

-- Document versioning: the master "__template" row holds the standard contract;
-- each property row stores the version it received (for individual + bulk send that
-- skips hoteliers who already have the current version).
alter table documents add column if not exists version int default 0;

-- ---------------------------------------------------------------------------
-- Roots Leads: qualified clients from the ROOTS Villas Google Form, matched to
-- LocalStay units by roots.js. The form pushes each submission (Apps Script) to
-- POST /api/roots-leads/ingest, which computes the client profile + top matches.
-- Dedup is by email OR phone (upsert), so returning respondents update in place.
-- ---------------------------------------------------------------------------

-- Per-property enrichment (profile_scores, environment, quality, capacity,
-- region, price band, constraints) computed from the imported master at import.
alter table properties add column if not exists enrichment jsonb;

create table if not exists roots_leads (
  id           uuid primary key default gen_random_uuid(),
  name         text,
  phone        text,
  email        text,
  origin_city  text,
  consent      text,
  raw          jsonb not null default '{}'::jsonb,   -- canonical answers {key:value}
  profile      jsonb,                                -- profileLead() output
  matches      jsonb default '[]'::jsonb,            -- [{slug, score, reasons, penalties}]
  source       text default 'roots_form',
  submissions  int default 1,                        -- how many times they've submitted
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);
create index if not exists roots_leads_email_idx on roots_leads(lower(email));
create index if not exists roots_leads_phone_idx on roots_leads(phone);
create index if not exists roots_leads_created_idx on roots_leads(created_at desc);

-- Contract "unread" tracking: when the master admin sends a document to a hotelier,
-- seen_at is reset to NULL. The hotelier console shows an unread dot + dashboard
-- prompt until they open the Documents tab (marks seen) / approve the unit (signs).
alter table documents add column if not exists seen_at timestamptz;
