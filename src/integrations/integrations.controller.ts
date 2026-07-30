import { Body, Controller, HttpCode, Post, UseGuards, UsePipes, ValidationPipe } from "@nestjs/common";
import { IntegrationsService } from "./integrations.service";
import { BuildersNodeGuard } from "./builders-node.guard";
import { ProvisionSubscriptionDto, type ProvisionSubscriptionResponse } from "./dto/provision-subscription.dto";

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
}
