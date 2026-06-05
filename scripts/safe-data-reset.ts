import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

import {
  CLEAN_DATA_CONFIRMATION,
  DEFAULT_PRESERVED_ADMIN_EMAILS,
  buildSafeDataResetSql,
  classifyResetData,
  validateResetOptions
} from "../src/admin/data-reset-plan";

type CliOptions = {
  execute: boolean;
  allowProduction: boolean;
  deleteAuditLogs: boolean;
  confirmation?: string;
  backupDir?: string;
  sqlOut?: string;
  preservedAdminEmails: string[];
};

function main() {
  const options = parseArgs(process.argv.slice(2));
  const preservedAdminEmails =
    options.preservedAdminEmails.length > 0 ? options.preservedAdminEmails : DEFAULT_PRESERVED_ADMIN_EMAILS;

  validateResetOptions({
    execute: options.execute,
    confirmation: options.confirmation,
    allowProduction: options.allowProduction,
    preservedAdminEmails,
    isProduction: isProductionLike()
  });

  const sql = buildSafeDataResetSql({
    preservedAdminEmails,
    deleteAuditLogs: options.deleteAuditLogs
  });

  printClassification(options.deleteAuditLogs);

  if (!options.execute) {
    if (options.sqlOut) {
      writeFileSync(resolve(options.sqlOut), sql, "utf8");
      console.log(`Dry-run SQL written to ${resolve(options.sqlOut)}`);
    } else {
      console.log("\n--- DRY RUN SQL ---\n");
      console.log(sql);
    }
    console.log(`Dry run only. Execute with --execute --confirm ${CLEAN_DATA_CONFIRMATION}.`);
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for execute mode.");
  }

  assertCommandAvailable("pg_dump");
  assertCommandAvailable("psql");

  const backupDir = resolve(options.backupDir ?? "backups");
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupDir, `prospera-db-backup-${timestamp}.dump`);
  const sqlPath = join(tmpdir(), `prospera-safe-data-reset-${timestamp}.sql`);

  console.log(`Creating backup: ${backupPath}`);
  runPostgresCommand("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--file", backupPath], databaseUrl);

  writeFileSync(sqlPath, sql, "utf8");
  if (options.sqlOut) {
    writeFileSync(resolve(options.sqlOut), sql, "utf8");
  }

  console.log("Running transactional cleanup SQL...");
  runPostgresCommand("psql", ["-v", "ON_ERROR_STOP=1", "-f", sqlPath], databaseUrl);

  console.log("Safe data reset completed.");
  console.log(`Backup saved at ${backupPath}`);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    execute: false,
    allowProduction: false,
    deleteAuditLogs: false,
    preservedAdminEmails: []
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value.`);
      }
      index += 1;
      return value;
    };

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--execute") {
      options.execute = true;
    } else if (arg === "--allow-production") {
      options.allowProduction = true;
    } else if (arg === "--delete-audit-logs") {
      options.deleteAuditLogs = true;
    } else if (arg === "--confirm") {
      options.confirmation = next();
    } else if (arg.startsWith("--confirm=")) {
      options.confirmation = arg.slice("--confirm=".length);
    } else if (arg === "--backup-dir") {
      options.backupDir = next();
    } else if (arg === "--sql-out") {
      options.sqlOut = next();
    } else if (arg === "--preserve-admin-email") {
      options.preservedAdminEmails.push(next());
    } else if (arg.startsWith("--preserve-admin-email=")) {
      options.preservedAdminEmails.push(arg.slice("--preserve-admin-email=".length));
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function printClassification(deleteAuditLogs: boolean) {
  const classification = classifyResetData();
  console.log("Safe reset classification:");
  console.log(`- System data kept: ${classification.systemData.join(", ")}`);
  console.log(`- Default seed data kept/reseeded: ${classification.defaultSeedData.join(", ")}`);
  console.log(`- User/test data deleted: ${classification.userGeneratedData.join(", ")}`);
  console.log(
    deleteAuditLogs
      ? `- Audit/log data deleted after backup: ${classification.auditData.join(", ")}`
      : `- Audit/log data kept where FK cascades allow it; full copy is in the backup: ${classification.auditData.join(", ")}`
  );
}

function printHelp() {
  console.log(`Usage:
  npm run db:safe-reset -- [options]

Options:
  --execute                         Run the cleanup. Default is dry-run SQL only.
  --confirm ${CLEAN_DATA_CONFIRMATION}       Required with --execute.
  --allow-production                Required when NODE_ENV or VERCEL_ENV is production.
  --delete-audit-logs               Delete audit/log tables after backup.
  --preserve-admin-email <email>    Admin email to preserve. Can be repeated.
  --backup-dir <path>               Backup directory. Default: backend/backups.
  --sql-out <path>                  Also write generated SQL to this path.
  --help                            Show this help.
`);
}

function isProductionLike() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}

function assertCommandAvailable(command: string) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  if (result.error) {
    throw new Error(`${command} is required but was not found in PATH.`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} --version failed: ${result.stderr || result.stdout}`);
  }
}

function runPostgresCommand(command: string, args: string[], databaseUrl: string) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      PGDATABASE: databaseUrl
    }
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}.`);
  }
}

main();
