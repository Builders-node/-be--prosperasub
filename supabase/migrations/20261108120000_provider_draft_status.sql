-- Applied 20261108120000 · provider_draft_status
--
-- A business being onboarded is a DRAFT, not "inactive". Until now there were
-- two statuses, so a business still being set up and one taken off the
-- platform looked the same. New businesses (admin create, application
-- approval) are now inserted as 'draft' by the app; this marks the batch of
-- merchant drafts created on 2026-11-03 the same way.
--
-- Nothing reads 'draft' as visible: listings filter status = 'active', and
-- reject_order_from_hidden_shop refuses orders unless active/approved.

update public.providers
   set status = 'draft', updated_at = now()
 where status = 'inactive'
   and id::text like '5a1e0000-0000-4000-8000-0000000000%';
