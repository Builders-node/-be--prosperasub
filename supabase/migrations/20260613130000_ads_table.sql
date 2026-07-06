-- Admin-managed promotional banners (ads)
create table if not exists public.ads (
  id uuid primary key default gen_random_uuid(),
  title text not null,                         -- internal admin name
  label text not null,                         -- main display text, e.g. "INFINITA MONEY"
  badge_text text,                             -- pill text, e.g. "Pay with LIVES"
  cta_text text,                               -- trailing text, e.g. "Open your account →"
  link_url text not null,                      -- destination on click
  placement text not null default 'home_top',  -- where it renders
  gradient_from text not null default '#6d28d9',
  gradient_via text not null default '#9333ea',
  gradient_to text not null default '#d946ef',
  text_color text not null default '#ffffff',
  badge_bg text not null default '#fde047',
  badge_text_color text not null default '#581c87',
  is_active boolean not null default true,
  dismissible boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ads_placement_active_idx
  on public.ads (placement, is_active, sort_order);

alter table public.ads enable row level security;

-- Permissive policy matching the other service tables (frontend uses anon key)
drop policy if exists ads_public_all on public.ads;
create policy ads_public_all on public.ads
  for all
  to public
  using (true)
  with check (true);

-- Seed the existing hardcoded Infinita banner so nothing changes visually
insert into public.ads (title, label, badge_text, cta_text, link_url, placement, sort_order)
values (
  'Infinita Money',
  'Infinita Money',
  'Pay with LIVES',
  'Open your account →',
  'https://infinita.money/',
  'home_top',
  1
);
