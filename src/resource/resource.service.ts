import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { BookingModel, ResourceRow, ResourceType } from "./resource-type";

/**
 * Resource domain OHS — read side over the generic `resource_types` registry and
 * `bookable_resources`. Booking/Order query resources through this rather than
 * touching tables directly. Reads via PostgREST (matches the rest of the
 * backend); writes + `resource.*` events come when resource authoring routes
 * through the domain.
 */
@Injectable()
export class ResourceService {
  private readonly logger = new Logger(ResourceService.name);

  constructor(private readonly config: ConfigService) {}

  async listTypes(activeOnly = true): Promise<ResourceType[]> {
    const filter = activeOnly ? "&is_active=eq.true" : "";
    return (await this.rest<ResourceType[]>(`resource_types?select=*${filter}&order=sort_order`)) ?? [];
  }

  async getType(key: string): Promise<ResourceType | null> {
    const rows = await this.rest<ResourceType[]>(
      `resource_types?select=*&key=eq.${encodeURIComponent(key)}&limit=1`,
    );
    return rows?.[0] ?? null;
  }

  async getResource(id: string): Promise<ResourceRow | null> {
    const rows = await this.rest<ResourceRow[]>(
      `bookable_resources?select=*&id=eq.${encodeURIComponent(id)}&limit=1`,
    );
    return rows?.[0] ?? null;
  }

  async listResources(opts: { providerId?: string; typeKey?: string } = {}): Promise<ResourceRow[]> {
    let path = `bookable_resources?select=*&order=sort_order`;
    if (opts.providerId) path += `&provider_id=eq.${encodeURIComponent(opts.providerId)}`;
    if (opts.typeKey) path += `&type=eq.${encodeURIComponent(opts.typeKey)}`;
    return (await this.rest<ResourceRow[]>(path)) ?? [];
  }

  /** The booking strategy for a resource, resolved via its type — the seam the Booking engine dispatches on. */
  async bookingModelForResource(resourceId: string): Promise<BookingModel | null> {
    const resource = await this.getResource(resourceId);
    if (!resource) return null;
    const type = await this.getType(resource.type);
    return type?.booking_model ?? null;
  }

  private async rest<T>(path: string): Promise<T | null> {
    const base = this.config.get<string>("SUPABASE_URL")?.replace(/\/$/, "");
    const key =
      this.config.get<string>("SUPABASE_SERVICE_ROLE_KEY") || this.config.get<string>("SUPABASE_ANON_KEY");
    if (!base || !key) return null;
    try {
      const res = await fetch(`${base}/rest/v1/${path}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      if (!res.ok) {
        this.logger.warn(`[resource.rest] ${path} → ${res.status}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      this.logger.error(`[resource.rest] ${path} network error: ${(err as Error).message}`);
      return null;
    }
  }
}
