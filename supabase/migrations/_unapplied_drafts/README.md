# Unapplied drafts

These 104 files were hand-written as the schema changed, with round timestamps
(`20260812160000`). **Not one of their versions appears in
`supabase_migrations.schema_migrations`** — the changes reached the database
through migrations with precise timestamps (`20260812172320`), which now sit
in the parent directory as the recovered history.

So each of these is either a draft of a change that landed under a different
version, or a change that never landed at all. Replaying the parent directory
runs the real history; replaying it *with* this folder would run several
changes twice.

They are kept, not deleted, because a few contain commentary the recovered SQL
does not — the recovered files are exactly what Postgres received, comments
and all, but the drafts sometimes explain *why*. Read them as notes.

Before deleting this folder, check nothing here describes a change that is
missing from the applied history.
