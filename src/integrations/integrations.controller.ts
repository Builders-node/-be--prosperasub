import { Body, Controller, HttpCode, Post, UseGuards, UsePipes, ValidationPipe } from "@nestjs/common";
import { IntegrationsService } from "./integrations.service";
import { BuildersNodeGuard } from "./builders-node.guard";
import { ProvisionSubscriptionDto, type ProvisionSubscriptionResponse } from "./dto/provision-subscription.dto";
import { AccessQrRequestDto, type AccessQrResponse } from "./dto/access-qr.dto";
import { BookingsRequestDto, type BookingsResponse } from "./dto/bookings.dto";

/**
 * Partner integration surface — narrow by design.
 *
 * Only one endpoint today: Builders Node calls it when they grant a member a
 * food/cleaning subscription on their side. We mirror the grant into our
 * tables so the assigned provider sees it on their Bookings tab immediately.
 *
 * If we later add other partners, each gets its own sub-path here (e.g.
 * `/integrations/<partner>/…`) with its own guard and its own DTOs. Do NOT
 * turn this into a generic "any partner writes anything" endpoint — the
 * value of a partner API is a stable, minimal contract per partner.
 */
@Controller("integrations/builders-node")
@UseGuards(BuildersNodeGuard)
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Post("subscription")
  @HttpCode(200)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }))
  provisionSubscription(@Body() body: ProvisionSubscriptionDto): Promise<ProvisionSubscriptionResponse> {
    return this.integrations.provisionSubscription(body);
  }

  /**
   * Mint a short-lived access QR for a user. The QR encodes a URL to our
   * `/verify` page which shows GREEN/RED against every ProsperaSub
   * subscription across services (cleaning + food + beach + rental).
   */
  @Post("access-qr")
  @HttpCode(200)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }))
  mintAccessQr(@Body() body: AccessQrRequestDto): Promise<AccessQrResponse> {
    return this.integrations.mintAccessQr(body);
  }

  /**
   * Aggregated view of a user's scheduled bookings across every service —
   * one row per cleaning visit, one per beach court reservation, one per
   * rental period, and one per food subscription window. Sorted by start_at.
   */
  @Post("bookings")
  @HttpCode(200)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }))
  listBookings(@Body() body: BookingsRequestDto): Promise<BookingsResponse> {
    return this.integrations.listBookings(body);
  }
}
