import { Body, Controller, HttpCode, Post, UseGuards, UsePipes, ValidationPipe } from "@nestjs/common";
import { IntegrationsService } from "./integrations.service";
import { BuildersNodeGuard } from "./builders-node.guard";
import { ProvisionSubscriptionDto, type ProvisionSubscriptionResponse } from "./dto/provision-subscription.dto";
import { AccessQrRequestDto, type AccessQrResponse } from "./dto/access-qr.dto";
import { BookingsRequestDto, type BookingsResponse } from "./dto/bookings.dto";
import {
  CreateCleaningBookingDto,
  type CreateCleaningBookingResponse,
} from "./dto/create-cleaning-booking.dto";
import { CleaningSlotsRequestDto, type CleaningSlotsResponse } from "./dto/cleaning-slots.dto";

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
   * `/verify` page which shows GREEN/RED against every EverySub
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

  /**
   * Book one cleaning visit for a user with an active paid subscription.
   * Called by Builders Node's UI after their customer picks date + time.
   *
   * `start_time` must be one the published grid actually offers — call
   * `/cleaning-slots` first and pass a listed value back. Anything else is a
   * 400 whose message lists that day's open times. `end_time` is ignored if
   * sent; the slot's own duration wins.
   *
   * The visit is pushed to the cleaners' Google Calendar during this call.
   * `calendar_synced: false` in the response means the booking is committed
   * but hasn't reached the calendar yet — the sync cron retries, so do NOT
   * re-issue the booking.
   */
  @Post("cleaning-booking")
  @HttpCode(200)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }))
  createCleaningBooking(@Body() body: CreateCleaningBookingDto): Promise<CreateCleaningBookingResponse> {
    return this.integrations.createCleaningBooking(body);
  }

  /**
   * Which cleaning times exist, and which are still free.
   *
   * Must be called before `cleaning-booking`: that endpoint only accepts a
   * start_time listed here, and rejects anything else with a 400. It used to
   * create a slot for a guessed time instead, which produced visits at hours
   * no cleaner is scheduled to work.
   */
  @HttpCode(200)
  @Post("cleaning-slots")
  listCleaningSlots(@Body() body: CleaningSlotsRequestDto): Promise<CleaningSlotsResponse> {
    return this.integrations.listCleaningSlots(body);
  }
}
