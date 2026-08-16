import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";

/**
 * Who runs a business — written here and nowhere else.
 *
 * `provider_members` used to be world-writable (`FOR ALL TO public`) and the
 * Team tab wrote it straight from the browser with the anon key. That table is
 * also what `OccurrencesService` consults to decide whether somebody may see a
 * provider's day — which carries home addresses and access instructions. So
 * anyone holding the anon key (it ships in the bundle) could insert one row and
 * read them. Same for `providers.admin_user_id`: setting it to yourself made
 * you the owner as far as the payout endpoint was concerned.
 *
 * Both writes now happen through here, with the service-role key, after this
 * service has checked that the caller is the owner or a platform admin. The
 * table's RLS keeps SELECT public (a membership list is not a secret) and
 * refuses writes to anon.
 */

export interface MemberRow {
  id: string;
  provider_id: string;
  user_id: string;
  user_email: string | null;
  user_name: string | null;
  role: string | null;
  created_at: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ProviderMembersService {
  private readonly logger = new Logger(ProviderMembersService.name);

  async list(userId: string, providerId: string, isAdmin: boolean): Promise<MemberRow[]> {
    await this.assertOwner(userId, providerId, isAdmin);
    const rows = await this.rest<MemberRow[]>(
      `provider_members?provider_id=eq.${this.enc(providerId)}&select=*&order=created_at.asc`,
    );
    return rows ?? [];
  }

  /**
   * Add a manager.
   *
   * The member must already have an account: an invitation keyed on a typed
   * email is how `provider_members` filled up with rows nothing could match a
   * session against. Email alone is still accepted — it is resolved to the
   * canonical `users.id` here, and refused if there is nobody behind it.
   */
  async add(
    userId: string,
    providerId: string,
    isAdmin: boolean,
    input: { userId?: string | null; userEmail?: string | null; userName?: string | null },
  ): Promise<MemberRow> {
    await this.assertOwner(userId, providerId, isAdmin);

    const member = await this.resolveUser(input.userId ?? null, input.userEmail ?? null);
    if (!member) {
      throw new BadRequestException(
        "No account matches that person yet — ask them to sign in once, then add them.",
      );
    }

    const existing = await this.rest<MemberRow[]>(
      `provider_members?provider_id=eq.${this.enc(providerId)}&user_id=eq.${this.enc(member.id)}&select=*&limit=1`,
    );
    if (existing?.length) return existing[0];

    const created = await this.post<MemberRow[]>("provider_members", {
      provider_id: providerId,
      user_id: member.id,
      user_email: member.email ?? input.userEmail ?? null,
      user_name: input.userName?.trim() || member.name || null,
      // Only ever "manager" from here. An owner is `providers.admin_user_id`,
      // set through setOwner — a role string that grants ownership would be a
      // second, quieter way to become the owner.
      role: "manager",
    });
    const row = created?.[0];
    if (!row) throw new BadRequestException("Could not add that person.");
    return row;
  }

  async remove(userId: string, providerId: string, isAdmin: boolean, memberId: string): Promise<{ removed: boolean }> {
    await this.assertOwner(userId, providerId, isAdmin);
    // Scoped by provider as well as id: the caller proved ownership of THIS
    // business, not of whatever row id they pass.
    await this.del(`provider_members?id=eq.${this.enc(memberId)}&provider_id=eq.${this.enc(providerId)}`);
    return { removed: true };
  }

  /** Hand the business to somebody else, or to nobody (platform-run). */
  async setOwner(
    userId: string,
    providerId: string,
    isAdmin: boolean,
    nextOwnerId: string | null,
  ): Promise<{ adminUserId: string | null }> {
    await this.assertOwner(userId, providerId, isAdmin);

    let ownerId: string | null = null;
    if (nextOwnerId) {
      const user = await this.resolveUser(nextOwnerId, null);
      if (!user) throw new BadRequestException("That user does not exist.");
      ownerId = user.id;
    }

    await this.patch(`providers?id=eq.${this.enc(providerId)}`, {
      admin_user_id: ownerId,
      updated_at: new Date().toISOString(),
    });
    return { adminUserId: ownerId };
  }

  // ─── Access ─────────────────────────────────────────────────────────────────

  /**
   * The owner, or a platform admin. A manager deliberately does NOT pass: the
   * person who runs the day cannot appoint themselves a colleague, or promote
   * themselves to owner.
   */
  private async assertOwner(userId: string, providerId: string, isAdmin: boolean): Promise<void> {
    if (isAdmin) return;
    const rows = await this.rest<Array<{ id: string; admin_user_id: string | null }>>(
      `providers?id=eq.${this.enc(providerId)}&select=id,admin_user_id&limit=1`,
    );
    const provider = rows?.[0];
    if (!provider) throw new NotFoundException("Provider not found.");
    if (!provider.admin_user_id || String(provider.admin_user_id) !== String(userId)) {
      throw new ForbiddenException("Only the owner of this business can change who runs it.");
    }
  }

  private async resolveUser(
    id: string | null,
    email: string | null,
  ): Promise<{ id: string; email: string | null; name: string | null } | null> {
    if (id && UUID_RE.test(id)) {
      const rows = await this.rest<Array<{ id: string; email: string | null; name: string | null }>>(
        `users?id=eq.${this.enc(id)}&select=id,email,name&limit=1`,
      );
      if (rows?.length) return rows[0];
    }
    const address = (email ?? (id && !UUID_RE.test(id) ? id : null))?.trim();
    if (address) {
      const rows = await this.rest<Array<{ id: string; email: string | null; name: string | null }>>(
        `users?email=eq.${this.enc(address)}&select=id,email,name&limit=1`,
      );
      if (rows?.length) return rows[0];
    }
    return null;
  }

  // ─── Supabase REST (service role — anon may read this table, never write it) ─

  private creds() {
    const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!base || !key) {
      throw new Error("provider_members writes need SUPABASE_SERVICE_ROLE_KEY.");
    }
    return { base, key };
  }

  private headers(extra: Record<string, string> = {}) {
    const { key } = this.creds();
    return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
  }

  private enc(value: string) { return encodeURIComponent(value); }

  private async rest<T>(path: string): Promise<T | null> {
    const { base } = this.creds();
    const res = await fetch(`${base}/rest/v1/${path}`, { headers: this.headers() });
    if (!res.ok) {
      this.logger.warn(`[provider-members] GET ${path} → ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T | null> {
    const { base } = this.creds();
    const res = await fetch(`${base}/rest/v1/${path}`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json", Prefer: "return=representation" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      this.logger.warn(`[provider-members] POST ${path} → ${res.status} ${detail}`);
      throw new BadRequestException("Could not save that change.");
    }
    return (await res.json()) as T;
  }

  private async patch(path: string, body: unknown): Promise<void> {
    const { base } = this.creds();
    const res = await fetch(`${base}/rest/v1/${path}`, {
      method: "PATCH",
      headers: this.headers({ "Content-Type": "application/json", Prefer: "return=minimal" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      this.logger.warn(`[provider-members] PATCH ${path} → ${res.status} ${detail}`);
      throw new BadRequestException("Could not save that change.");
    }
  }

  private async del(path: string): Promise<void> {
    const { base } = this.creds();
    const res = await fetch(`${base}/rest/v1/${path}`, {
      method: "DELETE",
      headers: this.headers({ Prefer: "return=minimal" }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      this.logger.warn(`[provider-members] DELETE ${path} → ${res.status} ${detail}`);
      throw new BadRequestException("Could not remove that person.");
    }
  }
}
