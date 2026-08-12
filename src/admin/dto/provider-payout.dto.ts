import { ApiProperty } from "@nestjs/swagger";
import { IsInt, IsISO8601, IsOptional, IsString, Min } from "class-validator";

/**
 * Recording money that has left the platform.
 *
 * Amount is in cents and must be at least 1 — the table's own CHECK says the
 * same thing, but a 400 with a sentence beats a Postgres constraint error
 * surfacing as a 500 to whoever is doing the books.
 */
export class CreateProviderPayoutDto {
  @ApiProperty({ description: "Amount sent, in cents." })
  @IsInt()
  @Min(1)
  amount_cents!: number;

  @ApiProperty({ required: false, nullable: true, description: "First day of the settled period." })
  @IsOptional()
  @IsString()
  period_start?: string | null;

  @ApiProperty({ required: false, nullable: true, description: "Last day of the settled period (inclusive)." })
  @IsOptional()
  @IsString()
  period_end?: string | null;

  @ApiProperty({ required: false, nullable: true, description: "lightning · onchain · paypal · cash · bank" })
  @IsOptional()
  @IsString()
  method?: string | null;

  @ApiProperty({ required: false, nullable: true, description: "Payment hash, txid, or transfer id." })
  @IsOptional()
  @IsString()
  reference?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  note?: string | null;

  @ApiProperty({ required: false, nullable: true, description: "Defaults to now." })
  @IsOptional()
  @IsISO8601()
  paid_at?: string | null;
}
