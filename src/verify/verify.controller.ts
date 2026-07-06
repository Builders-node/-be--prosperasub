import { Body, Controller, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiProperty, ApiResponse, ApiTags } from "@nestjs/swagger";
import { IsString } from "class-validator";
import type { Request } from "express";
import { AccountAuthGuard, type AccountRequest } from "../account/account-auth.guard";
import { VerifyService } from "./verify.service";

class VerifyAccessDto {
  @ApiProperty({ description: "Signed token decoded from the scanned QR code." })
  @IsString()
  token!: string;
}

@ApiTags("Verify")
@Controller()
export class VerifyController {
  constructor(private readonly verify: VerifyService) {}

  @ApiOperation({ summary: "Mint a short-lived access-verification token for the signed-in user's QR code" })
  @ApiBearerAuth()
  @ApiResponse({ status: 201, description: "Signed token + TTL." })
  @UseGuards(AccountAuthGuard)
  @Post("verify/token")
  mintToken(@Req() req: AccountRequest) {
    return this.verify.mintToken(req.authUser!.id);
  }

  @ApiOperation({ summary: "Verify a scanned QR token and return the user's access status + all subscriptions" })
  @ApiBody({ type: VerifyAccessDto })
  @ApiResponse({ status: 201, description: "Access decision with the full subscription list." })
  @Post("verify-access")
  verifyAccess(@Body() body: VerifyAccessDto, @Req() req: Request) {
    const ip =
      (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      null;
    const userAgent = (req.headers["user-agent"] as string | undefined) ?? null;
    return this.verify.verifyAccess(body.token, { ip, userAgent });
  }
}
