-- A business's "write a review" link on Google (Google Business Profile →
-- Ask for reviews). The app offers it to customers who rate the business 4 or
-- 5 stars on EverySub, so the business's Google rating grows with ours.
-- Edited by the business in its workspace (Edit business) or by the admin.
alter table public.providers add column if not exists google_review_url text;

comment on column public.providers.google_review_url is
  'https:// link to the business''s Google review form; offered after a 4–5 star rating.';
