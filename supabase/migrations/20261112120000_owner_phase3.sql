-- Owners, phase 3: team invites ride the owner-invite table.
--
-- `kind` = 'owner' (the hand-over link, default — every existing row) or
-- 'member' (a team invite, routes/provider-growth.ts). Claiming a member
-- invite adds a provider_members row as manager; it never sets the owner.
alter table public.provider_owner_invites add column if not exists kind text not null default 'owner';
alter table public.provider_owner_invites drop constraint if exists provider_owner_invites_kind_check;
alter table public.provider_owner_invites add constraint provider_owner_invites_kind_check check (kind in ('owner', 'member'));
