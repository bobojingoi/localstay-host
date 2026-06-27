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
