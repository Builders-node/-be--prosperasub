import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { PublicDataService } from "./public-data.service";
import { PublicApiKeyGuard } from "./public-api-key.guard";

/**
 * Generic key-protected CRUD over the platform's data (Cleaning / Food / Cars /
 * Beach / Massage / Users). Backed by Supabase with the service role, so it has
 * full admin-level access. Filtering uses PostgREST query syntax, e.g.
 *   GET /v1/data/food_subscriptions?status=eq.active&select=*&order=created_at.desc&limit=20
 */
@ApiTags("Public Data API")
@ApiHeader({ name: "x-api-key", description: "Your ProsperaSub public API key", required: true })
@UseGuards(PublicApiKeyGuard)
@Controller("v1/data")
export class PublicDataController {
  constructor(private readonly data: PublicDataService) {}

  @ApiOperation({ summary: "List rows from a table (PostgREST filters via query string)." })
  @Get(":table")
  list(@Param("table") table: string, @Req() req: { url: string }) {
    const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : "";
    return this.data.list(table, query);
  }

  @ApiOperation({ summary: "Get a single row by id." })
  @Get(":table/:id")
  getOne(@Param("table") table: string, @Param("id") id: string) {
    return this.data.getOne(table, id);
  }

  @ApiOperation({ summary: "Insert a row (or array of rows)." })
  @Post(":table")
  insert(@Param("table") table: string, @Body() body: unknown) {
    return this.data.insert(table, body);
  }

  @ApiOperation({ summary: "Update a row by id." })
  @Patch(":table/:id")
  update(@Param("table") table: string, @Param("id") id: string, @Body() body: Record<string, unknown>) {
    return this.data.update(table, id, body);
  }

  @ApiOperation({ summary: "Delete a row by id." })
  @Delete(":table/:id")
  remove(@Param("table") table: string, @Param("id") id: string) {
    return this.data.remove(table, id);
  }
}
