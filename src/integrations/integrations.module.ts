import { Module } from "@nestjs/common";
import { IntegrationsController } from "./integrations.controller";
import { IntegrationsService } from "./integrations.service";
import { BuildersNodeGuard } from "./builders-node.guard";

@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsService, BuildersNodeGuard],
})
export class IntegrationsModule {}
