import {
  CLEAN_DATA_CONFIRMATION,
  DEFAULT_PRESERVED_ADMIN_EMAILS,
  buildSafeDataResetSql,
  classifyResetData,
  validateResetOptions
} from "./data-reset-plan";

describe("safe data reset plan", () => {
  it("classifies system, seed, resettable, and audit data separately", () => {
    const classification = classifyResetData();

    expect(classification.systemData).toEqual(
      expect.arrayContaining(["supabase_migrations", "auth.users", "public.users:preserved_admins"])
    );
    expect(classification.defaultSeedData).toEqual(
      expect.arrayContaining(["global_settings", "cleaning_packages"])
    );
    expect(classification.userGeneratedData).toEqual(
      expect.arrayContaining(["cleaning_bookings", "cleaning_plan_client_assignments", "users:non_preserved"])
    );
    expect(classification.auditData).toEqual(
      expect.arrayContaining(["admin_audit_logs", "login_history", "admin_payment_notifications"])
    );
  });

  it("builds a transactional SQL reset that preserves admins and avoids schema changes", () => {
    const sql = buildSafeDataResetSql({
      preservedAdminEmails: DEFAULT_PRESERVED_ADMIN_EMAILS,
      deleteAuditLogs: false
    });

    expect(sql).toContain("BEGIN;");
    expect(sql).toContain("COMMIT;");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("CREATE TEMP TABLE _prospera_preserved_admins");
    expect(sql).toContain("RAISE EXCEPTION 'Safe reset aborted: no preserved super admin account found'");
    expect(sql).toContain("DELETE FROM public.users WHERE id::text NOT IN (SELECT id FROM _prospera_preserved_admins)");
    expect(sql).toContain("INSERT INTO public.global_settings");
    expect(sql).toContain("INSERT INTO public.cleaning_packages");
    expect(sql).toContain("information_schema.columns");

    expect(sql).not.toMatch(/\bDROP\s+/i);
    expect(sql).not.toMatch(/\bTRUNCATE\s+/i);
    expect(sql).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(sql).not.toContain("auth.users");
    expect(sql).not.toContain("admin_audit_logs");
  });

  it("only includes audit log deletes when explicitly requested", () => {
    const sql = buildSafeDataResetSql({
      preservedAdminEmails: DEFAULT_PRESERVED_ADMIN_EMAILS,
      deleteAuditLogs: true
    });

    expect(sql).toContain("admin_audit_logs");
    expect(sql).toContain("login_history");
  });

  it("requires explicit confirmation before execute mode", () => {
    expect(() =>
      validateResetOptions({
        execute: true,
        confirmation: "wrong",
        allowProduction: true,
        preservedAdminEmails: DEFAULT_PRESERVED_ADMIN_EMAILS
      })
    ).toThrow(`--confirm ${CLEAN_DATA_CONFIRMATION}`);
  });

  it("requires at least one preserved admin email", () => {
    expect(() =>
      validateResetOptions({
        execute: false,
        confirmation: undefined,
        allowProduction: false,
        preservedAdminEmails: []
      })
    ).toThrow("At least one preserved admin email");
  });
});
