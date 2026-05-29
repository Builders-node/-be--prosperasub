import { BadRequestException, Injectable, Logger, Optional, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "crypto";
import { MailService } from "../mail/mail.service";
import { PrismaService } from "../prisma/prisma.service";
import { PasswordService } from "./password.service";
import { RoleName, SessionService } from "./session.service";

export type ApiRole = "super_admin" | "restaurant_admin" | "driver" | "user";

export interface ApiUser {
  id: string;
  email: string;
  name: string;
  display_name: string;
  auth_provider: "email" | "google";
  avatar_url: string | null;
  lightning_pubkey: string | null;
  restaurant_id: string | null;
}

interface GoogleTokenResponse {
  access_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

interface GoogleTokenInfo {
  aud?: string;
  sub?: string;
  email?: string;
  email_verified?: string | boolean;
  name?: string;
  picture?: string;
  error?: string;
  error_description?: string;
}

/** Shape returned by auth RPC functions */
interface RpcUser {
  id: string;
  email: string;
  name: string;
  display_name: string;
  auth_provider: string;
  avatar_url: string | null;
  lightning_pubkey: string | null;
  roles: string[];
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /** In-memory password hash for the Frorex owner account (fallback / seed). */
  private passwordHash: string | null = null;

  /**
   * Short-lived reset tokens: { token → { email, expiresAt } }.
   * Kept in-memory; valid only within the same Lambda instance.
   */
  private readonly resetTokens = new Map<string, { email: string; expiresAt: number }>();

  /**
   * Cache for users seen this instance lifetime (Google OAuth, sign-ups, etc.)
   * so we don't need a DB round-trip on every /me call.
   */
  private readonly oauthUsers = new Map<string, { user: ApiUser; roles: ApiRole[] }>();

  /** Hard-coded owner/super-admin identity (Frorex Studio). */
  private readonly user: ApiUser = {
    id: "owned-user-frorex",
    email: "frorex.studio@gmail.com",
    name: "Frorex Studio",
    display_name: "Frorex",
    auth_provider: "email",
    avatar_url: null,
    lightning_pubkey: null,
    restaurant_id: null
  };

  private readonly roles: ApiRole[] = ["super_admin", "user"];

  constructor(
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  // ─── Supabase REST API helper ─────────────────────────────────────────────

  /**
   * Call a Supabase RPC function over HTTPS (PostgREST).
   * Works from Vercel serverless — uses port 443, not 5432.
   */
  async supabaseRpc<T>(
    fn: string,
    params: Record<string, unknown>,
  ): Promise<T | null> {
    const supabaseUrl = this.config.get<string>("SUPABASE_URL");
    const anonKey    = this.config.get<string>("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !anonKey) return null;

    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey":        anonKey,
          "Authorization": `Bearer ${anonKey}`,
        },
        body: JSON.stringify(params),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string; error?: string };
        this.logger.warn(`[supabaseRpc] ${fn} → ${res.status}: ${body?.message ?? body?.error ?? res.statusText}`);
        // Surface the raw body so callers can inspect specific messages
        const err = new Error(body?.message ?? body?.error ?? `Supabase RPC ${fn} failed (${res.status})`);
        (err as Error & { status: number }).status = res.status;
        throw err;
      }

      return (await res.json()) as T;
    } catch (err) {
      // Re-throw errors that already have a status (already logged above)
      if ((err as Error & { status?: number }).status) throw err;
      this.logger.error(`[supabaseRpc] ${fn} network error: ${(err as Error).message}`);
      return null;
    }
  }

  private isSupabaseAvailable(): boolean {
    if (process.env.NODE_ENV === "test") return false;
    return !!(this.config.get<string>("SUPABASE_URL") && this.config.get<string>("SUPABASE_ANON_KEY"));
  }

  // ─── Public auth methods ───────────────────────────────────────────────────

  async login(email: string, password: string) {
    const normalizedEmail = email.trim().toLowerCase();

    // ── Frorex owner bypass (works with or without DB) ─────────────────────
    if (normalizedEmail === this.user.email) {
      await this.ensurePasswordHash();
      const isValid = await this.passwords.verify(password, this.passwordHash!);
      if (!isValid) throw new UnauthorizedException("Invalid email or password");
      void this.upsertUserInDb(this.user, this.roles);
      return this.createSessionResponse();
    }

    // ── All other users — require Supabase ────────────────────────────────
    if (!this.isSupabaseAvailable()) {
      throw new UnauthorizedException("Invalid email or password");
    }

    let rpcUser: RpcUser | null = null;
    try {
      rpcUser = await this.supabaseRpc<RpcUser>("auth_login_verify", {
        p_email:    normalizedEmail,
        p_password: password,
      });
    } catch (err) {
      this.logger.error(`login RPC error: ${(err as Error).message}`);
      throw new UnauthorizedException("Invalid email or password");
    }

    if (!rpcUser) {
      throw new UnauthorizedException("Invalid email or password");
    }

    const apiUser = this.rpcUserToApiUser(rpcUser);
    const roles   = (rpcUser.roles ?? []).map((r) => r.toLowerCase() as ApiRole);
    const effectiveRoles = roles.length ? roles : (["user"] as ApiRole[]);
    this.oauthUsers.set(apiUser.id, { user: apiUser, roles: effectiveRoles });

    return this.createSessionResponse(apiUser, effectiveRoles);
  }

  async signUp(email: string, password: string, name?: string) {
    const normalizedEmail = email.trim().toLowerCase();

    // ── Frorex owner → redirect to login ──────────────────────────────────
    if (normalizedEmail === this.user.email) {
      return this.login(normalizedEmail, password);
    }

    // ── No Supabase available (test / local dev without config) ───────────
    if (!this.isSupabaseAvailable() || process.env.NODE_ENV === "test") {
      const user: ApiUser = {
        id: `owned-user-${Date.now()}`,
        email: normalizedEmail,
        name: name || normalizedEmail,
        display_name: name || normalizedEmail,
        auth_provider: "email",
        avatar_url: null,
        lightning_pubkey: null,
        restaurant_id: null,
      };
      const roles: ApiRole[] = ["user"];
      this.oauthUsers.set(user.id, { user, roles });
      return this.createSessionResponse(user, roles);
    }

    // ── Create user via Supabase RPC (hashes password server-side) ─────────
    let rpcUser: RpcUser | null = null;
    try {
      rpcUser = await this.supabaseRpc<RpcUser>("auth_signup_user", {
        p_email:    normalizedEmail,
        p_name:     name ?? "",
        p_password: password,
      });
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.includes("CONFLICT") || msg.includes("already exists")) {
        throw new BadRequestException(
          "An account with this email already exists. Please log in instead."
        );
      }
      this.logger.error(`signUp RPC error: ${msg}`);
      throw new BadRequestException("Registration failed. Please try again.");
    }

    if (!rpcUser) {
      throw new BadRequestException("Registration failed. Please try again.");
    }

    const apiUser = this.rpcUserToApiUser(rpcUser);
    const roles   = (rpcUser.roles ?? ["user"]).map((r) => r.toLowerCase() as ApiRole);
    this.oauthUsers.set(apiUser.id, { user: apiUser, roles });

    return this.createSessionResponse(apiUser, roles);
  }

  meFromAccessToken(accessToken: string) {
    try {
      const payload = this.sessions.verifyAccessToken(accessToken);

      if (payload.typ !== "access") {
        throw new UnauthorizedException("Invalid access token");
      }

      const identity = this.findIdentity(payload.sub) ?? this.identityFromTokenPayload(payload);
      if (!identity) {
        throw new UnauthorizedException("Invalid access token");
      }

      return {
        user: identity.user,
        roles: identity.roles
      };
    } catch {
      throw new UnauthorizedException("Invalid or expired access token");
    }
  }

  async refresh(refreshToken: string) {
    try {
      const payload = this.sessions.verifyRefreshToken(refreshToken);

      if (payload.typ !== "refresh") {
        throw new UnauthorizedException("Invalid refresh token");
      }

      const identity = this.findIdentity(payload.sub) ?? this.identityFromTokenPayload(payload);
      if (!identity) {
        throw new UnauthorizedException("Invalid refresh token");
      }

      return this.createSessionResponse(identity.user, identity.roles);
    } catch {
      throw new UnauthorizedException("Invalid or expired refresh token");
    }
  }

  startGoogleOAuth(redirectUrl: string, state: string) {
    const clientId = this.googleClientId();
    const redirect = this.safeOAuthRedirectUrl(redirectUrl);

    if (!state.trim()) {
      throw new BadRequestException("OAuth state is required");
    }

    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirect.toString());
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("prompt", "select_account");

    return { url: url.toString() };
  }

  async completeGoogleOAuth(code: string, redirectUrl: string) {
    const redirect = this.safeOAuthRedirectUrl(redirectUrl);
    const tokenResponse = await this.exchangeGoogleCode(code, redirect.toString());
    const tokenInfo = await this.verifyGoogleIdToken(tokenResponse.id_token);

    const email = tokenInfo.email?.trim().toLowerCase();
    if (!tokenInfo.sub || !email || !this.isGoogleEmailVerified(tokenInfo.email_verified)) {
      throw new UnauthorizedException("Google account email could not be verified");
    }

    const user = this.userFromGoogleProfile(tokenInfo);
    const roles = email === this.user.email ? this.roles : (["user"] as ApiRole[]);
    this.oauthUsers.set(user.id, { user, roles });
    void this.upsertUserInDb(user, roles);

    return this.createSessionResponse(user, roles);
  }

  async requestPasswordReset(email: string, redirectUrl?: string) {
    const normalizedEmail = email.trim().toLowerCase();

    const isFrorex = normalizedEmail === this.user.email;
    let isKnownUser = isFrorex;

    if (!isFrorex && this.isSupabaseAvailable()) {
      try {
        const found = await this.supabaseRpc<boolean>("auth_check_email", {
          p_email: normalizedEmail,
        });
        isKnownUser = found === true;
      } catch {
        // enumeration-safe: treat unknown as not found
      }
    }

    const silentResponse = {
      ok: true,
      email: normalizedEmail,
      resetToken: null,
      resetUrl: null,
      message: "If the account exists, reset instructions will be available."
    };

    if (!isKnownUser) return silentResponse;

    const resetToken = randomBytes(24).toString("hex");
    this.resetTokens.set(resetToken, {
      email: normalizedEmail,
      expiresAt: Date.now() + 1000 * 60 * 30
    });

    const resetUrl = this.buildResetUrl(resetToken, redirectUrl);
    await this.sendPasswordResetEmail(normalizedEmail, resetUrl);

    const baseResponse = {
      ok: true,
      email: normalizedEmail,
      message: "If the account exists, reset instructions will be available."
    };

    if (this.isProduction()) {
      return { ...baseResponse, resetToken: null, resetUrl: null };
    }

    return { ...baseResponse, resetToken, resetUrl };
  }

  async confirmPasswordReset(token: string, password: string) {
    const reset = this.resetTokens.get(token);

    if (!reset || reset.expiresAt < Date.now()) {
      throw new UnauthorizedException("Invalid or expired reset token");
    }

    const { email } = reset;
    this.resetTokens.delete(token);

    if (email === this.user.email) {
      this.passwordHash = await this.passwords.hash(password);
    } else if (this.isSupabaseAvailable()) {
      try {
        await this.supabaseRpc<boolean>("auth_update_password", {
          p_email:    email,
          p_password: password,
        });
      } catch (err) {
        this.logger.error(`confirmPasswordReset RPC error: ${(err as Error).message}`);
        throw new UnauthorizedException("Password reset failed. Please try again.");
      }
    } else {
      throw new UnauthorizedException("Invalid or expired reset token");
    }

    return { success: true };
  }

  /**
   * Returns every user the auth service knows about (hardcoded Frorex + all
   * users cached in this instance's memory). Used by AdminService so the
   * admin panel can merge with DB users.
   */
  listAllUsers(): Array<ApiUser & { roles: ApiRole[] }> {
    const result: Array<ApiUser & { roles: ApiRole[] }> = [
      { ...this.user, roles: this.roles },
    ];

    for (const { user, roles } of this.oauthUsers.values()) {
      if (!result.some((u) => u.email === user.email)) {
        result.push({ ...user, roles });
      }
    }

    return result;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /** Convert an RPC result row to ApiUser. */
  private rpcUserToApiUser(row: RpcUser): ApiUser {
    return {
      id:             row.id,
      email:          row.email || "",
      name:           row.name || row.email || "",
      display_name:   row.display_name || row.name || row.email || "",
      auth_provider:  row.auth_provider === "google" ? "google" : "email",
      avatar_url:     row.avatar_url ?? null,
      lightning_pubkey: row.lightning_pubkey ?? null,
      restaurant_id:  null,
    };
  }

  private async sendPasswordResetEmail(email: string, resetUrl: string) {
    try {
      await this.mail.sendPasswordResetEmail({ to: email, resetUrl });
    } catch (error) {
      console.error("Password reset email failed", error);
    }
  }

  private async ensurePasswordHash() {
    if (!this.passwordHash) {
      const seedHash = this.config.get<string>("FROREX_SEED_PASSWORD_HASH")?.trim();
      const seedPassword = this.config.get<string>("FROREX_SEED_PASSWORD")?.trim();

      if (seedHash) {
        this.passwordHash = seedHash;
        return;
      }

      if (this.isProduction() && !seedPassword) {
        throw new Error("FROREX_SEED_PASSWORD_HASH or FROREX_SEED_PASSWORD must be set in production");
      }

      this.passwordHash = await this.passwords.hash(seedPassword || "111111");
    }
  }

  private async createSessionResponse(user = this.user, roles = this.roles) {
    const accessTtl = Number(this.config.get("ACCESS_TOKEN_TTL_SECONDS") ?? 900);
    const tokenPair = await this.sessions.createTokenPair({
      userId: user.id,
      roles: roles.map((role) => role.toUpperCase() as RoleName),
      email: user.email,
      name: user.name,
      authProvider: user.auth_provider,
      avatarUrl: user.avatar_url
    });

    return {
      user,
      roles,
      session: {
        access_token:  tokenPair.accessToken,
        refresh_token: tokenPair.refreshToken,
        expires_at:    Math.floor(Date.now() / 1000) + accessTtl,
        user
      }
    };
  }

  private findIdentity(userId: string) {
    if (userId === this.user.id) {
      return { user: this.user, roles: this.roles };
    }

    return this.oauthUsers.get(userId) ?? null;
  }

  private identityFromTokenPayload(payload: {
    sub: string;
    email?: string;
    name?: string;
    roles?: RoleName[];
    authProvider?: string;
    avatarUrl?: string | null;
  }) {
    if (!payload.email) return null;

    const roles = (payload.roles ?? ["USER"]).map((role) => role.toLowerCase() as ApiRole);
    const user: ApiUser = {
      id: payload.sub,
      email: payload.email,
      name: payload.name || payload.email,
      display_name: payload.name || payload.email,
      auth_provider: payload.authProvider === "google" ? "google" : "email",
      avatar_url: payload.avatarUrl ?? null,
      lightning_pubkey: null,
      restaurant_id: null
    };

    this.oauthUsers.set(user.id, { user, roles });
    return { user, roles };
  }

  private userFromGoogleProfile(profile: GoogleTokenInfo): ApiUser {
    const email = profile.email!.trim().toLowerCase();

    if (email === this.user.email) {
      return {
        ...this.user,
        name: profile.name || this.user.name,
        display_name: profile.name || this.user.display_name,
        auth_provider: "google",
        avatar_url: profile.picture || this.user.avatar_url
      };
    }

    return {
      id: `google-${this.safeExternalId(profile.sub!)}`,
      email,
      name: profile.name || email,
      display_name: profile.name || email,
      auth_provider: "google",
      avatar_url: profile.picture || null,
      lightning_pubkey: null,
      restaurant_id: null
    };
  }

  private safeExternalId(value: string) {
    return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
  }

  private async exchangeGoogleCode(code: string, redirectUri: string): Promise<GoogleTokenResponse> {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.googleClientId(),
        client_secret: this.googleClientSecret(),
        redirect_uri: redirectUri,
        grant_type: "authorization_code"
      })
    });

    const body = (await response.json().catch(() => null)) as GoogleTokenResponse | null;

    if (!response.ok || !body?.id_token) {
      throw new UnauthorizedException(body?.error_description || body?.error || "Google OAuth token exchange failed");
    }

    return body;
  }

  private async verifyGoogleIdToken(idToken?: string): Promise<GoogleTokenInfo> {
    if (!idToken) {
      throw new UnauthorizedException("Google ID token is missing");
    }

    const url = new URL("https://oauth2.googleapis.com/tokeninfo");
    url.searchParams.set("id_token", idToken);
    const response = await fetch(url);
    const body = (await response.json().catch(() => null)) as GoogleTokenInfo | null;

    if (!response.ok || !body?.sub || body.aud !== this.googleClientId()) {
      throw new UnauthorizedException(body?.error_description || body?.error || "Google ID token is invalid");
    }

    return body;
  }

  private isGoogleEmailVerified(value: GoogleTokenInfo["email_verified"]) {
    return value === true || value === "true";
  }

  private googleClientId() {
    const clientId = this.config.get<string>("GOOGLE_OAUTH_CLIENT_ID") || this.config.get<string>("GOOGLE_CLIENT_ID");
    if (!clientId?.trim()) {
      throw new BadRequestException("Google OAuth client ID is not configured");
    }

    return clientId.trim();
  }

  private googleClientSecret() {
    const clientSecret = this.config.get<string>("GOOGLE_OAUTH_CLIENT_SECRET") || this.config.get<string>("GOOGLE_CLIENT_SECRET");
    if (!clientSecret?.trim()) {
      throw new BadRequestException("Google OAuth client secret is not configured");
    }

    return clientSecret.trim();
  }

  private buildResetUrl(resetToken: string, redirectUrl?: string) {
    const base = this.safeResetBaseUrl(redirectUrl);
    base.searchParams.set("token", resetToken);
    return base.toString();
  }

  private safeResetBaseUrl(redirectUrl?: string) {
    const fallback = this.config.get<string>("APP_RESET_PASSWORD_URL") || "http://localhost:8080/reset-password";
    const allowedOrigins = this.allowedRedirectOrigins();

    try {
      const requested = new URL(redirectUrl || fallback);
      if (allowedOrigins.has(requested.origin)) {
        return requested;
      }
    } catch {
      // Use the configured fallback below.
    }

    return new URL(fallback);
  }

  private safeOAuthRedirectUrl(redirectUrl: string) {
    const allowedOrigins = this.allowedRedirectOrigins();

    try {
      const requested = new URL(redirectUrl);
      if (allowedOrigins.has(requested.origin)) {
        return requested;
      }
    } catch {
      // Fall through to the explicit error below.
    }

    throw new BadRequestException("OAuth redirect URL is not allowed");
  }

  private allowedRedirectOrigins() {
    const configured = (this.config.get<string>("APP_ALLOWED_REDIRECT_ORIGINS") || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);

    const origins = new Set(configured);
    origins.add("https://prosperasub.com");
    origins.add("https://www.prosperasub.com");

    if (!this.isProduction()) {
      origins.add("http://localhost:8080");
      origins.add("http://127.0.0.1:8080");
      origins.add("http://localhost:8081");
      origins.add("http://127.0.0.1:8081");
    }

    return origins;
  }

  /**
   * Upserts a user into Supabase via RPC (Google OAuth / owner sync).
   * Non-blocking — errors are logged and swallowed.
   */
  private async upsertUserInDb(user: ApiUser, roles: ApiRole[]): Promise<void> {
    if (!this.isSupabaseAvailable() || !user.email) return;
    if (process.env.NODE_ENV === "test") return;

    try {
      await this.supabaseRpc("auth_upsert_oauth_user", {
        p_email:        user.email,
        p_name:         user.name || user.email,
        p_display_name: user.display_name || user.name || user.email,
        p_provider:     user.auth_provider === "google" ? "google" : "email",
        p_avatar_url:   user.avatar_url ?? null,
      });
    } catch (err) {
      this.logger.warn(`[upsertUserInDb] Failed: ${(err as Error).message}`);
    }
  }

  private isProduction() {
    return this.config.get<string>("NODE_ENV") === "production";
  }
}
