import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsArray, IsInt, IsOptional, IsString, ValidateNested } from "class-validator";
import { AccountAuthGuard, type AccountRequest } from "../account/account-auth.guard";
import { OrderService } from "./order.service";

class OrderLineDto {
  @IsString() kind!: string;
  @IsString() ref!: string;
}
class PlaceOrderDto {
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => OrderLineDto) lines?: OrderLineDto[];
  @IsOptional() @IsInt() amount_cents?: number;
  @IsOptional() @IsString() currency?: string;
}

/**
 * Order surface. Placing an order requires an account token (subject taken from
 * the guard). Payment then references `order:<id>` so the saga confirms it.
 */
@ApiTags("Orders")
@Controller("orders")
export class OrderController {
  constructor(private readonly orders: OrderService) {}

  @ApiOperation({ summary: "Place an order (pending payment)" })
  @UseGuards(AccountAuthGuard)
  @Post()
  place(@Req() req: AccountRequest, @Body() body: PlaceOrderDto) {
    return this.orders.placeOrder({
      subjectRef: `user:${req.authUser!.id}`,
      lines: body.lines ?? [],
      amountCents: body.amount_cents,
      currency: body.currency,
    });
  }

  @ApiOperation({ summary: "Get an order" })
  @UseGuards(AccountAuthGuard)
  @Get(":id")
  get(@Param("id") id: string) {
    return this.orders.get(id);
  }
}
