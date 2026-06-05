import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength } from "class-validator";

export class CreateRoleDto {
  @IsString()
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsIn(["active", "inactive"])
  status!: "active" | "inactive";

  @IsOptional()
  @IsBoolean()
  isAdminRole?: boolean;

  @IsArray()
  @IsString({ each: true })
  permissions!: string[];
}

export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsIn(["active", "inactive"])
  status?: "active" | "inactive";

  @IsOptional()
  @IsBoolean()
  isAdminRole?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];
}

export class AssignUserRolesDto {
  @IsArray()
  @IsString({ each: true })
  roleIds!: string[];
}
