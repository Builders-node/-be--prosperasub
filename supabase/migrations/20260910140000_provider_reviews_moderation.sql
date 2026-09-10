-- Somebody has to be able to take a review down.
--
-- There was no admin surface for provider_reviews at all — a fake or abusive
-- one could only be removed with SQL — and no column to remove it WITH short of
-- deleting the row. Deleting is the wrong tool: a business that complains about
-- a review deserves a record of what was said and who took it down, and a
-- customer who wrote a fair one deserves it not to vanish silently.
--
-- Hidden, not deleted. Every reader filters `hidden_at is null`; the row stays.

alter table public.provider_reviews add column if not exists hidden_at     timestamptz;
alter table public.provider_reviews add column if not exists hidden_by     uuid;
alter table public.provider_reviews add column if not exists hidden_reason text;

-- The public lists and the rating average both read "not hidden", and that is
-- the only shape they read in.
create index if not exists provider_reviews_visible_idx
  on public.provider_reviews (provider_id) where hidden_at is null;

comment on column public.provider_reviews.hidden_at is
  'Set by an admin taking the review off the storefront. The row stays for the record; every reader filters on this being null.';
