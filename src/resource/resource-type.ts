/**
 * Resource domain — generic reservable entities. The `ResourceType` registry is
 * the "add an industry by config" surface: a type declares its `booking_model`
 * (the strategy the Booking engine uses) and a metadata schema. Nothing here
 * names an industry — that lives in the data.
 */

export type BookingModel = "time_slot" | "date_range" | "capacity_seat";

export interface ResourceType {
  key: string;
  label: string;
  booking_model: BookingModel;
  metadata_schema: Record<string, unknown>;
  constraints: Record<string, unknown>;
  is_active: boolean;
  sort_order: number;
}

export interface ResourceRow {
  id: string;
  provider_id: string | null;
  name: string;
  type: string;                 // → ResourceType.key
  capacity: number | null;
  hours: unknown;
  metadata: Record<string, unknown> | null;
  status: string | null;
  /** Bridge to the legacy per-service table (e.g. "beach", "cars"). */
  source_service_key?: string | null;
  /** Legacy record id in the source table (beach_club_courts.id, rental_vehicles.id …). */
  source_resource_id?: string | null;
}
