import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { createNestApp } from "./bootstrap";

async function bootstrap() {
  const app = await createNestApp();
  const config = app.get(ConfigService);
  const port = Number(config.get("API_PORT") ?? 4000);
  const host = config.get("API_HOST") ?? "127.0.0.1";

  await app.listen(port, host);
}

void bootstrap();
