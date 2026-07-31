import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { EventsModule } from "../../events/events.module";
import { ResourceModule } from "../../resource/resource.module";
import { LeadconnectorService } from "./leadconnector.service";
import { LeadconnectorBeachHandler } from "./leadconnector-beach.handler";

@Module({
  imports: [PrismaModule, EventsModule, ResourceModule],
  providers: [LeadconnectorService, LeadconnectorBeachHandler],
  exports: [LeadconnectorService],
})
export class LeadconnectorModule {}
