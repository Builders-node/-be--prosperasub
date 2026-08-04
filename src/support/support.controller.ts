import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiResponse, ApiTags } from "@nestjs/swagger";
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { SupportService } from "./support.service";
import { SessionService } from "../auth/session.service";
import { AdminAuthGuard, type AdminRequest } from "../admin/admin-auth.guard";
import { AdminPermission, RequireAdminPermission } from "../admin/admin-permissions";

class SetHandledDto {
  @ApiProperty({ example: true })
  @IsOptional()
  handled?: boolean;
}

class SupportMessageDto {
  @ApiProperty({ example: "Maria Lopez" })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: "maria@example.com" })
  @IsEmail()
  @MaxLength(200)
  email!: string;

  @ApiProperty({ required: false, example: "+504 9999 0000" })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @ApiProperty({ example: "Cleaning didn't arrive" })
  @IsString()
  @MinLength(3)
  @MaxLength(160)
  subject!: string;

  @ApiProperty({ example: "Nobody came on Tuesday and the slot still shows as booked." })
  @IsString()
  @MinLength(10)
  // Long enough for a real problem, short enough that the inbox stays readable
  // and a paste-bomb can't be used to flood it.
  @MaxLength(4000)
  message!: string;

  @ApiProperty({ required: false, description: "Page the customer was on." })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  page_url?: string;
}

/**
 * Public support endpoint — a signed-out visitor has to be able to reach a
 * human too, so this is deliberately not behind AccountAuthGuard. When a
 * session token IS present we attach the user id, which saves the admin
 * matching a name to an account by hand.
 */
@ApiTags("Support")
@Controller("support")
export class SupportController {
  constructor(
    private readonly support: SupportService,
    private readonly sessions: SessionService,
  ) {}

  @ApiOperation({ summary: "Send a support message" })
  @ApiResponse({ status: 201, description: "Stored, and emailed to the support inbox." })
  @Post("messages")
  async submit(@Body() body: SupportMessageDto, @Req() req: { headers: Record<string, string | undefined> }) {
    // Attach the sender when we can, but never reject on a bad token — losing
    // the message would be worse than losing the attribution.
    let userId: string | null = null;
    const raw = req.headers?.authorization;
    if (raw?.startsWith("Bearer ")) {
      try {
        userId = this.sessions.verifyAccessToken(raw.slice(7))?.sub ?? null;
      } catch {
        userId = null;
      }
    }
    return this.support.submit({ ...body, user_id: userId });
  }
}

/**
 * Admin side of the same inbox.
 *
 * Reads go through here rather than straight from the browser: the table is
 * service-role only because every row carries a name, an email and whatever
 * the customer chose to write. Pointing the admin page at PostgREST with the
 * anon key would have returned an empty list — and looked like "no messages"
 * rather than "no access".
 */
@ApiTags("Support")
@ApiBearerAuth()
@UseGuards(AdminAuthGuard)
@Controller("admin/support")
export class AdminSupportController {
  constructor(private readonly support: SupportService) {}

  @ApiOperation({ summary: "List customer support messages" })
  @RequireAdminPermission(AdminPermission.UsersRead)
  @Get("messages")
  list(@Query("status") status?: string) {
    return this.support.list(status);
  }

  @ApiOperation({ summary: "Mark a message handled or back to new" })
  @RequireAdminPermission(AdminPermission.UsersRead)
  @Patch("messages/:id")
  setStatus(@Param("id") id: string, @Body() body: SetHandledDto, @Req() req: AdminRequest) {
    return this.support.setStatus(id, body.handled !== false, req.adminUser?.id ?? null);
  }
}
