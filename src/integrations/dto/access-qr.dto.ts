import { IsEmail, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from "class-validator";

/**
 * Request body for `POST /integrations/builders-node/access-qr`.
 *
 * Identify the user by either `email` (we upsert on the fly if absent) or by
 * `user_id` if Builders Node has stored the id from a prior
 * `POST .../subscription` response. At least one must be present.
 *
 * `ttl_seconds` caps the QR's usefulness window — shorter is safer (a screenshot
 * or leaked token expires quickly), longer is convenient (users leave their
 * profile open and re-check throughout the day). Server clamps to sane bounds.
 */
export class AccessQrRequestDto {
  @IsOptional() @IsEmail() @MaxLength(255) email?: string;
  @IsOptional() @IsUUID() user_id?: string;
  @IsOptional() @IsInt() @Min(30) @Max(3600) ttl_seconds?: number;
}

export interface AccessQrResponse {
  user_id: string;
  /** The signed short-lived token — embed in the QR or hand off directly. */
  token: string;
  /** Full URL a scanner should land on. Also the value we encode inside qr_svg. */
  verify_url: string;
  /** SVG string ready to inject — no QR library needed on Builders Node's side. */
  qr_svg: string;
  /** Data-URL wrapping the SVG for `<img src=…>` usage. */
  qr_data_url: string;
  /** Seconds from now the token stops being valid. */
  expires_in: number;
}
