-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260902231029 · mirror_rental_occurrence_helper

-- Upsert ONE occurrence for a rental. Split out because a rental produces two
-- of them from a single booking row — the handover and the return — which is
-- what makes it different from every other mirror, where one legacy record is
-- one occurrence. `mirror_find_occurrence` already keys on item_key, so the
-- pair coexists under the same source_record_id without fighting.
CREATE OR REPLACE FUNCTION mirror_rental_occurrence_one(
  p_record   text,
  p_provider uuid,
  p_user     uuid,
  p_item     text,
  p_at       timestamptz,
  p_status   text,
  p_notes    text,
  p_access   text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_existing uuid;
BEGIN
  IF p_provider IS NULL OR p_at IS NULL THEN RETURN; END IF;

  v_existing := mirror_find_occurrence('vehicles', p_record, p_item, NULL, p_at);

  IF v_existing IS NOT NULL THEN
    UPDATE service_occurrences SET
      provider_id = p_provider,
      user_id     = COALESCE(p_user, user_id),
      starts_at   = p_at,
      -- A handover and a return are moments, not windows: the car is out for
      -- the days between them, and that span is the booking, not the job.
      ends_at     = p_at,
      status      = p_status,
      notes       = COALESCE(p_notes, notes),
      access_instructions = COALESCE(p_access, access_instructions),
      updated_at  = now()
    WHERE id = v_existing;
  ELSE
    INSERT INTO service_occurrences
      (provider_id, user_id, item_key, starts_at, ends_at, status, notes,
       access_instructions, source_service_key, source_record_id)
    VALUES
      (p_provider, p_user, p_item, p_at, p_at, p_status, p_notes,
       p_access, 'vehicles', p_record);
  END IF;
END;
$$;
