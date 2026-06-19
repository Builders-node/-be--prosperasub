-- Beach Club service module: editable membership plans + public inquiry capture.
create table if not exists public.beach_club_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  tagline text,
  price_per_person_cents integer not null default 0,
  amenities jsonb not null default '[]'::jsonb,
  featured boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.beach_club_inquiries (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid references public.beach_club_plans(id) on delete set null,
  plan_name text,
  user_id text,
  name text,
  email text,
  whatsapp text,
  message text,
  status text not null default 'new',
  admin_notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.beach_club_plans enable row level security;
alter table public.beach_club_inquiries enable row level security;
create policy beach_club_plans_all on public.beach_club_plans for all to public using (true) with check (true);
create policy beach_club_inquiries_all on public.beach_club_inquiries for all to public using (true) with check (true);

insert into public.beach_club_plans (name, tagline, price_per_person_cents, amenities, featured, sort_order) values
  ('Beach Club Membership', 'Full access to Beach Club amenities, billed monthly.', 6500,
   '["Gym access","Pools","Water park","Sports courts"]'::jsonb, false, 1),
  ('Membership + Golf', 'Everything in Membership, plus daily range time at Pete''s.', 7500,
   '["All Membership amenities","One bucket of balls daily at Pete''s"]'::jsonb, true, 2);
