import { Body, Controller, Get, Post } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiProperty, ApiResponse, ApiTags } from "@nestjs/swagger";
import { IsEmail, IsOptional, IsString, MinLength } from "class-validator";
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

  @ApiOperation({ summary: "Return current user and roles" })
  @ApiResponse({ status: 200, description: "Current owned API user and roles." })
  @Get("me")
  me() {
    return this.auth.me();
  }
}
