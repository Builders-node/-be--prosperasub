import { Body, Controller, Get, Headers, Post, Query, UnauthorizedException } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiProperty, ApiResponse, ApiTags } from "@nestjs/swagger";
import { IsEmail, IsIn, IsOptional, IsString, MinLength } from "class-validator";
import { AuthService } from "./auth.service";

class LoginDto {
  @ApiProperty({ example: "admin@example.com" })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: "ChangeMe123!", format: "password", writeOnly: true })
  @IsString()
  password!: string;
}

class SignUpDto {
  @ApiProperty({ example: "user@example.com" })
  @IsEmail()
  email!: string;

  @ApiProperty({ minLength: 4, example: "ChangeMe123!", format: "password", writeOnly: true })
  @IsString()
  @MinLength(4)
  password!: string;

  @ApiProperty({ example: "User Name" })
  @IsString()
  name!: string;
}

class RequestPasswordResetDto {
  @ApiProperty({ example: "user@example.com" })
  @IsEmail()
  email!: string;

  @ApiProperty({ required: false, example: "http://localhost:8080/reset-password" })
  @IsOptional()
  @IsString()
  redirectUrl?: string;
}

class ConfirmPasswordResetDto {
  @ApiProperty({ example: "reset-token-example" })
  @IsString()
  token!: string;

  @ApiProperty({ minLength: 6, example: "NewPassword123!", format: "password", writeOnly: true })
  @IsString()
  @MinLength(6)
  password!: string;
}

class RefreshSessionDto {
  @ApiProperty({ example: "refresh-token-example", writeOnly: true })
  @IsString()
  refresh_token!: string;
}

class GoogleOAuthStartDto {
  @ApiProperty({ example: "https://prosperasub.com/auth" })
  @IsString()
  redirectUrl!: string;

  @ApiProperty({ example: "oauth-state-value" })
  @IsString()
  state!: string;
}

class GoogleOAuthCallbackDto {
  @ApiProperty({ enum: ["google"], example: "google" })
  @IsIn(["google"])
  provider!: "google";

  @ApiProperty({ example: "authorization-code-from-google", writeOnly: true })
  @IsString()
  code!: string;

  @ApiProperty({ example: "https://prosperasub.com/auth" })
  @IsString()
  redirectUrl!: string;
}

@ApiTags("Auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @ApiOperation({ summary: "Log in with email and password" })
  @ApiBody({ type: LoginDto })
  @ApiResponse({ status: 201, description: "Authenticated user, roles, and session tokens." })
  @ApiResponse({ status: 401, description: "Invalid email or password." })
  @Post("login")
  login(@Body() body: LoginDto) {
    return this.auth.login(body.email, body.password);
  }

  @ApiOperation({ summary: "Create a user or log in the configured account" })
  @ApiBody({ type: SignUpDto })
  @ApiResponse({ status: 201, description: "Created user response. New users currently receive no session." })
  @Post("signup")
  signUp(@Body() body: SignUpDto) {
    return this.auth.signUp(body.email, body.password, body.name);
  }

  @ApiOperation({ summary: "Request a password reset token" })
  @ApiBody({ type: RequestPasswordResetDto })
  @ApiResponse({ status: 201, description: "Reset request accepted. Development may include resetToken and resetUrl." })
  @Post("password-reset/request")
  requestPasswordReset(@Body() body: RequestPasswordResetDto) {
    return this.auth.requestPasswordReset(body.email, body.redirectUrl);
  }

  @ApiOperation({ summary: "Confirm password reset" })
  @ApiBody({ type: ConfirmPasswordResetDto })
  @ApiResponse({ status: 201, description: "Password changed." })
  @ApiResponse({ status: 401, description: "Invalid or expired reset token." })
  @Post("password-reset/confirm")
  confirmPasswordReset(@Body() body: ConfirmPasswordResetDto) {
    return this.auth.confirmPasswordReset(body.token, body.password);
  }

  @ApiOperation({ summary: "Refresh an access token with a valid refresh token" })
  @ApiBody({ type: RefreshSessionDto })
  @ApiResponse({ status: 201, description: "New authenticated user, roles, and session tokens." })
  @ApiResponse({ status: 401, description: "Invalid or expired refresh token." })
  @Post("refresh")
  refresh(@Body() body: RefreshSessionDto) {
    return this.auth.refresh(body.refresh_token);
  }

  @ApiOperation({ summary: "Start Google OAuth login" })
  @ApiBody({ type: GoogleOAuthStartDto })
  @ApiResponse({ status: 201, description: "Google authorization URL." })
  @Post("google/start")
  startGoogleOAuth(@Body() body: GoogleOAuthStartDto) {
    return this.auth.startGoogleOAuth(body.redirectUrl, body.state);
  }

  @ApiOperation({ summary: "Complete Google OAuth login" })
  @ApiBody({ type: GoogleOAuthCallbackDto })
  @ApiResponse({ status: 201, description: "Authenticated user, roles, and session tokens." })
  @Post("google/callback")
  completeGoogleOAuth(@Body() body: GoogleOAuthCallbackDto) {
    return this.auth.completeGoogleOAuth(body.code, body.redirectUrl);
  }

  @ApiOperation({ summary: "Return current user and roles" })
  @ApiBearerAuth()
  @ApiResponse({ status: 200, description: "Current authenticated API user and roles." })
  @ApiResponse({ status: 401, description: "Missing or invalid access token." })
  @Get("me")
  me(@Headers("authorization") authorization?: string) {
    return this.auth.meFromAccessToken(this.readBearerToken(authorization));
  }

  /**
   * Public callback for Google Calendar OAuth2 authorization.
   * Google redirects here after the admin grants Calendar access.
   * Copy the returned `code` and call POST /admin/google-calendar/exchange-code.
   */
  @ApiOperation({ summary: "Google Calendar OAuth2 callback — shows the authorization code" })
  @ApiResponse({ status: 200, description: "Authorization code ready to be exchanged." })
  @Get("calendar/callback")
  googleCalendarCallback(@Query("code") code?: string, @Query("error") error?: string) {
    if (error) {
      return { ok: false, error };
    }
    if (!code) {
      return { ok: false, error: "No authorization code received from Google." };
    }
    return {
      ok: true,
      code,
      message: "Authorization code received. Copy it and use POST /admin/google-calendar/exchange-code.",
      next: {
        method: "POST",
        url: "https://api.prosperasub.com/admin/google-calendar/exchange-code",
        body: {
          code,
          redirect_uri: "https://api.prosperasub.com/auth/calendar/callback",
        },
        note: "You must be authenticated as super_admin to call this endpoint.",
      },
    };
  }

  private readBearerToken(authorization?: string) {
    const [scheme, token] = authorization?.split(" ") ?? [];

    if (scheme !== "Bearer" || !token) {
      throw new UnauthorizedException("Bearer token is required");
    }

    return token;
  }
}
