import { Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AccountAuthGuard, type AccountRequest } from "../account/account-auth.guard";
import { FoodService } from "./food.service";

@ApiTags("Food")
@ApiBearerAuth()
@UseGuards(AccountAuthGuard)
@Controller("account/food/subscriptions")
export class FoodController {
  constructor(private readonly food: FoodService) {}

  @ApiOperation({ summary: "Get a food subscription with a server-enforced access decision + this week's menu" })
  @ApiResponse({ status: 200, description: "Access decision; menu included only when access is granted." })
  @Get(":id")
  getAccess(@Param("id") id: string, @Req() req: AccountRequest) {
    return this.food.getSubscriptionAccess(req.authUser!.id, id);
  }

  @ApiOperation({ summary: "Renew a food subscription (continuous period, no payment)" })
  @ApiResponse({ status: 201, description: "Renewed; returns new start/end dates." })
  @Post(":id/renew")
  renew(@Param("id") id: string, @Req() req: AccountRequest) {
    return this.food.renewSubscription(req.authUser!.id, id);
  }
}
