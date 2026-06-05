import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export interface CleaningPreferences {
  reminder_enabled: boolean;
  reminder_method: string;      // "all" | "email" | "in_app"
  reminder_minutes_before: number;
  access_instructions: string | null;
}

@Injectable()
export class AccountPreferencesService {
  private readonly logger = new Logger(AccountPreferencesService.name);

  constructor(private readonly prisma: PrismaService) {}

  private get dbAvailable() { return this.prisma.isAvailable(); }

  private supabaseRest<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!baseUrl || !key) throw new Error("Supabase REST not configured");
    return fetch(`${baseUrl}/rest/v1${path}`, {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...(init.headers || {}),
      },
    }).then(async (res) => {
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message || `Supabase ${res.status}`);
      return body as T;
    });
  }

  async getPreferences(userId: string): Promise<CleaningPreferences> {
    const defaults: CleaningPreferences = {
      reminder_enabled: true,
      reminder_method: "all",
      reminder_minutes_before: 60,
      access_instructions: null,
    };

    try {
      if (this.dbAvailable) {
        const row = await this.prisma.userCleaningPreferences.findUnique({ where: { userId } });
        if (!row) return defaults;
        return {
          reminder_enabled: row.reminderEnabled,
          reminder_method: row.reminderMethod,
          reminder_minutes_before: row.reminderMinutesBefore,
          access_instructions: row.accessInstructions,
        };
      }

      const rows = await this.supabaseRest<any[]>(
        `/user_cleaning_preferences?user_id=eq.${encodeURIComponent(userId)}&limit=1`,
      );
      if (!rows?.length) return defaults;
      const r = rows[0];
      return {
        reminder_enabled: r.reminder_enabled,
        reminder_method: r.reminder_method,
        reminder_minutes_before: r.reminder_minutes_before,
        access_instructions: r.access_instructions,
      };
    } catch (err) {
      this.logger.warn(`getPreferences fallback defaults: ${(err as Error).message}`);
      return defaults;
    }
  }

  async updatePreferences(userId: string, input: Partial<CleaningPreferences>): Promise<CleaningPreferences> {
    const data = {
      reminder_enabled:        input.reminder_enabled        ?? true,
      reminder_method:         input.reminder_method         ?? "all",
      reminder_minutes_before: input.reminder_minutes_before ?? 60,
      access_instructions:     input.access_instructions     ?? null,
      updated_at:              new Date().toISOString(),
    };

    try {
      if (this.dbAvailable) {
        const upserted = await this.prisma.userCleaningPreferences.upsert({
          where:  { userId },
          create: { userId, ...{ reminderEnabled: data.reminder_enabled, reminderMethod: data.reminder_method, reminderMinutesBefore: data.reminder_minutes_before, accessInstructions: data.access_instructions } },
          update: {           reminderEnabled: data.reminder_enabled, reminderMethod: data.reminder_method, reminderMinutesBefore: data.reminder_minutes_before, accessInstructions: data.access_instructions },
        });
        return {
          reminder_enabled: upserted.reminderEnabled,
          reminder_method: upserted.reminderMethod,
          reminder_minutes_before: upserted.reminderMinutesBefore,
          access_instructions: upserted.accessInstructions,
        };
      }

      // Supabase REST upsert
      await this.supabaseRest(
        `/user_cleaning_preferences?on_conflict=user_id`,
        {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=representation" },
          body: JSON.stringify({ user_id: userId, ...data }),
        },
      );
    } catch (err) {
      this.logger.warn(`updatePreferences error: ${(err as Error).message}`);
      throw err;
    }

    return this.getPreferences(userId);
  }
}
