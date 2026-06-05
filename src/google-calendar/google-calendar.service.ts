import { Injectable, Logger } from "@nestjs/common";
import { createSign } from "node:crypto";

const SHARED_CLEANING_CALENDAR_ENV = "GOOGLE_CLEANING_CALENDAR_ID";

export interface GoogleCalendarEventPayload {
  summary: string;
  location?: string;
  description?: string;
  start: Date;
  end: Date;
  recurrence?: string[];
  colorId?: string;
  /** Stored in extendedProperties.private for idempotent lookup */
  bookingId?: string;
}

export interface GoogleCalendarEventResult {
  id: string;
  htmlLink?: string | null;
}

export interface GoogleCalendarEventItem {
  id: string;
  summary?: string;
  status?: string;
  htmlLink?: string;
  created?: string;
  updated?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  extendedProperties?: {
    private?: Record<string, string>;
  };
}

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
}

type AuthMethod = "service_account" | "oauth2_refresh_token" | "none";

@Injectable()
export class GoogleCalendarService {
  private readonly logger = new Logger(GoogleCalendarService.name);
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  /** True when at least one auth method is fully configured. */
  isConfigured() {
    return this.authMethod !== "none" && Boolean(this.sharedAdminCleaningCalendarId);
  }

  getConfigurationStatus() {
    const method = this.authMethod;
    return {
      hasCalendarId: Boolean(this.sharedAdminCleaningCalendarId),
      authMethod: method,
      // Service-account fields
      hasClientEmail: Boolean(this.clientEmail),
      hasPrivateKey: Boolean(this.privateKey),
      clientEmailLooksServiceAccount: this.clientEmailLooksServiceAccount(),
      privateKeyLooksValid: this.privateKeyLooksValid(),
      // OAuth2 fields
      hasRefreshToken: Boolean(this.refreshToken),
      hasOAuthClientId: Boolean(this.oauthClientId),
      hasOAuthClientSecret: Boolean(this.oauthClientSecret),
    };
  }

  getSharedAdminCleaningCalendarId() {
    return this.sharedAdminCleaningCalendarId ?? null;
  }

  /**
   * Test the Google Calendar connection by fetching the calendar metadata.
   * Does not require a database connection — safe to call from a health check.
   */
  async testConnection(): Promise<{ ok: boolean; calendarSummary?: string; calendarId?: string; eventCount?: number; error?: string }> {
    if (!this.isConfigured()) {
      return { ok: false, error: "Google Calendar is not configured.", ...this.getConfigurationStatus() as object };
    }

    const calendarId = this.sharedAdminCleaningCalendarId!;
    try {
      const token = await this.getAccessToken();
      // Use events list (works with calendar.events scope) rather than calendar metadata
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?maxResults=1`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json() as { items?: unknown[]; summary?: string; error?: { message: string } };
      if (!res.ok) {
        const msg = json?.error?.message ?? res.statusText;
        return { ok: false, calendarId, error: `Google Calendar API returned ${res.status}: ${msg}` };
      }
      return { ok: true, calendarId, eventCount: json.items?.length ?? 0 };
    } catch (err) {
      return { ok: false, calendarId, error: (err as Error).message };
    }
  }

  /**
   * Build the Google OAuth2 authorization URL that the admin should visit
   * once to grant Calendar access. After authorizing, exchange the code via
   * `exchangeOAuthCode()`.
   */
  getOAuthAuthorizationUrl(redirectUri: string) {
    const params = new URLSearchParams({
      client_id: this.oauthClientId ?? "",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/calendar.events",
      access_type: "offline",
      prompt: "consent",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  /**
   * Exchange a one-time authorization code for an access + refresh token pair.
   * Store the returned `refresh_token` as GOOGLE_CALENDAR_REFRESH_TOKEN in
   * your Vercel environment variables.
   */
  async exchangeOAuthCode(code: string, redirectUri: string) {
    if (!this.oauthClientId || !this.oauthClientSecret) {
      throw new Error("GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET is not set.");
    }

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.oauthClientId,
        client_secret: this.oauthClientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    const json = await res.json() as { access_token?: string; refresh_token?: string; error?: string; error_description?: string };
    if (!res.ok) {
      throw new Error(`OAuth2 token exchange failed: ${json.error_description ?? json.error ?? res.statusText}`);
    }

    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      note: json.refresh_token
        ? "Save refresh_token as GOOGLE_CALENDAR_REFRESH_TOKEN in your Vercel env vars."
        : "No refresh_token returned — make sure access_type=offline and prompt=consent were used.",
    };
  }

  async createEvent(payload: GoogleCalendarEventPayload): Promise<GoogleCalendarEventResult> {
    const response = await this.request<{ id: string; htmlLink?: string }>("POST", `/events`, this.toGoogleEvent(payload));
    return { id: response.id, htmlLink: response.htmlLink ?? null };
  }

  async updateEvent(eventId: string, payload: GoogleCalendarEventPayload): Promise<GoogleCalendarEventResult> {
    const response = await this.request<{ id: string; htmlLink?: string }>("PATCH", `/events/${encodeURIComponent(eventId)}`, this.toGoogleEvent(payload));
    return { id: response.id, htmlLink: response.htmlLink ?? null };
  }

  async deleteEvent(eventId: string) {
    try {
      await this.request<void>("DELETE", `/events/${encodeURIComponent(eventId)}`);
    } catch (error) {
      if (error instanceof Error && /Google Calendar request failed \(404\)|Google Calendar request failed \(410\)/.test(error.message)) {
        return;
      }
      throw error;
    }
  }

  /**
   * Find all calendar events tagged with a specific bookingId in extendedProperties.
   * Returns events sorted by updated desc (newest first).
   */
  async findEventsByBookingId(bookingId: string): Promise<GoogleCalendarEventItem[]> {
    try {
      const response = await this.request<{ items?: GoogleCalendarEventItem[] }>(
        "GET",
        `/events?privateExtendedProperty=${encodeURIComponent(`bookingId=${bookingId}`)}&showDeleted=false&maxResults=10`,
      );
      const items = response.items ?? [];
      return items.sort((a, b) =>
        (b.updated ?? b.created ?? "").localeCompare(a.updated ?? a.created ?? ""),
      );
    } catch {
      return [];
    }
  }

  /**
   * Fallback: find events by title prefix + date (for old events without extendedProperties).
   */
  async findEventsByFallback(summaryPrefix: string, startDate: string): Promise<GoogleCalendarEventItem[]> {
    try {
      const timeMin = `${startDate}T00:00:00Z`;
      const timeMax = `${startDate}T23:59:59Z`;
      const response = await this.request<{ items?: GoogleCalendarEventItem[] }>(
        "GET",
        `/events?q=${encodeURIComponent(summaryPrefix)}&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&showDeleted=false&maxResults=20`,
      );
      return response.items ?? [];
    } catch {
      return [];
    }
  }

  /** Cancel (mark as cancelled) a Google Calendar event without deleting it. */
  async cancelEvent(eventId: string, payload: GoogleCalendarEventPayload): Promise<GoogleCalendarEventResult> {
    const body = {
      ...this.toGoogleEvent(payload),
      status: "cancelled",
      colorId: "11", // Tomato — visually marks it as cancelled
    };
    const response = await this.request<{ id: string; htmlLink?: string }>("PATCH", `/events/${encodeURIComponent(eventId)}`, body);
    return { id: response.id, htmlLink: response.htmlLink ?? null };
  }

  // ─── Private environment accessors ────────────────────────────────────────

  private get sharedAdminCleaningCalendarId() {
    return process.env[SHARED_CLEANING_CALENDAR_ENV]?.trim();
  }

  private get clientEmail() {
    return (process.env.GOOGLE_CALENDAR_CLIENT_EMAIL || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL)?.trim();
  }

  private get privateKey() {
    return (process.env.GOOGLE_CALENDAR_PRIVATE_KEY || process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY)?.replace(/\\n/g, "\n");
  }

  private get refreshToken() {
    return process.env.GOOGLE_CALENDAR_REFRESH_TOKEN?.trim();
  }

  private get oauthClientId() {
    return (process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID)?.trim();
  }

  private get oauthClientSecret() {
    return (process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET)?.trim();
  }

  private get timeZone() {
    return process.env.GOOGLE_CALENDAR_TIME_ZONE || "America/Tegucigalpa";
  }

  // ─── Auth method detection ─────────────────────────────────────────────────

  private get authMethod(): AuthMethod {
    if (this.clientEmailLooksServiceAccount() && this.privateKeyLooksValid()) {
      return "service_account";
    }
    if (this.refreshToken && this.oauthClientId && this.oauthClientSecret) {
      return "oauth2_refresh_token";
    }
    return "none";
  }

  private clientEmailLooksServiceAccount() {
    return Boolean(this.clientEmail?.endsWith(".gserviceaccount.com"));
  }

  private privateKeyLooksValid() {
    return Boolean(this.privateKey?.includes("BEGIN PRIVATE KEY"));
  }

  // ─── HTTP layer ────────────────────────────────────────────────────────────

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const calendarId = this.sharedAdminCleaningCalendarId;
    if (!this.isConfigured() || !calendarId) {
      const status = this.getConfigurationStatus();
      throw new Error(
        `Google Calendar is not configured (method=${status.authMethod}). ` +
        `Set ${SHARED_CLEANING_CALENDAR_ENV} and either service-account credentials ` +
        `or GOOGLE_CALENDAR_REFRESH_TOKEN + OAuth client credentials.`
      );
    }

    const token = await this.getAccessToken();
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    const json = text ? JSON.parse(text) : null;

    if (!response.ok) {
      const message = json?.error?.message || response.statusText;
      throw new Error(`Google Calendar request failed (${response.status}): ${message}`);
    }

    return json as T;
  }

  // ─── Token acquisition ─────────────────────────────────────────────────────

  private async getAccessToken() {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    if (this.authMethod === "service_account") {
      return this.getAccessTokenViaServiceAccount();
    }

    if (this.authMethod === "oauth2_refresh_token") {
      return this.getAccessTokenViaOAuth2();
    }

    throw new Error("Google Calendar auth is not configured.");
  }

  private async getAccessTokenViaServiceAccount() {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const assertion = this.signJwt({
      iss: this.clientEmail,
      scope: "https://www.googleapis.com/auth/calendar",
      aud: "https://oauth2.googleapis.com/token",
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    });

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });

    const json = (await response.json()) as GoogleTokenResponse & { error?: string; error_description?: string };
    if (!response.ok) {
      const reason = json.error_description || json.error || response.statusText;
      this.logger.warn(`Google Calendar service-account token failed: ${reason}`);
      throw new Error(`Google Calendar token request failed: ${reason}`);
    }

    this.accessToken = json.access_token;
    this.accessTokenExpiresAt = Date.now() + json.expires_in * 1000;
    return this.accessToken;
  }

  private async getAccessTokenViaOAuth2() {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.refreshToken!,
        client_id: this.oauthClientId!,
        client_secret: this.oauthClientSecret!,
      }),
    });

    const json = (await response.json()) as GoogleTokenResponse & { error?: string; error_description?: string };
    if (!response.ok) {
      const reason = json.error_description || json.error || response.statusText;
      this.logger.warn(`Google Calendar OAuth2 token refresh failed: ${reason}`);
      throw new Error(`Google Calendar OAuth2 token refresh failed: ${reason}`);
    }

    this.accessToken = json.access_token;
    this.accessTokenExpiresAt = Date.now() + json.expires_in * 1000;
    return this.accessToken;
  }

  private signJwt(payload: Record<string, unknown>) {
    const header = { alg: "RS256", typ: "JWT" };
    const unsignedToken = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
    const signature = createSign("RSA-SHA256").update(unsignedToken).sign(this.privateKey!).toString("base64url");
    return `${unsignedToken}.${signature}`;
  }

  /**
   * Format a Date as a local-time ISO string for the given IANA timezone,
   * e.g. "2026-05-28T08:00:00".  Google Calendar interprets this as local
   * time when `timeZone` is also supplied — which is the correct behaviour.
   * Using `.toISOString()` (always UTC with a Z suffix) worked fine when
   * the Date was already in UTC, but caused a 6-hour shift when the Date
   * was created without an explicit offset on a UTC server.
   */
  private toLocalISOString(date: Date, tz: string): string {
    const parts = new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(date);
    // sv-SE produces "YYYY-MM-DD HH:mm:ss" — swap space for T
    return parts.replace(" ", "T");
  }

  private toGoogleEvent(payload: GoogleCalendarEventPayload) {
    const tz = this.timeZone;
    return {
      summary: payload.summary,
      location: payload.location,
      description: payload.description,
      colorId: payload.colorId,
      start: {
        dateTime: this.toLocalISOString(payload.start, tz),
        timeZone: tz,
      },
      end: {
        dateTime: this.toLocalISOString(payload.end, tz),
        timeZone: tz,
      },
      recurrence: payload.recurrence,
      // Idempotency fingerprint — used to find/deduplicate events on re-sync
      ...(payload.bookingId && {
        extendedProperties: {
          private: {
            bookingId: payload.bookingId,
            source: "prosperasub-cleaning",
          },
        },
      }),
    };
  }
}

function base64Url(value: string) {
  return Buffer.from(value).toString("base64url");
}
