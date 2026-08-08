import cookieParser from "cookie-parser";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { buildAllowedOrigins } from "./config/app-origins";

export async function createNestApp() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const isProduction = config.get("NODE_ENV") === "production";
  const cookieSecret = config.get<string>("COOKIE_SECRET")?.trim();

  if (isProduction && (!cookieSecret || cookieSecret.length < 32)) {
    throw new Error("COOKIE_SECRET must be set to at least 32 characters in production");
  }

  app.getHttpAdapter().getInstance().disable("x-powered-by");
  app.use(cookieParser(cookieSecret || "dev-only-cookie-secret-change-before-production"));
  app.use((_request: unknown, response: { setHeader: (name: string, value: string) => void }, next: () => void) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    next();
  });
  // Public payments API (/v1/payments/*): open CORS for any origin. Access is
  // gated by an API key (not cookies), so cross-origin use is safe here.
  app.use((request: any, response: any, next: () => void) => {
    if (typeof request.url === "string" && request.url.startsWith("/v1/")) {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,x-api-key");
      response.setHeader("Access-Control-Max-Age", "86400");
      if (request.method === "OPTIONS") {
        response.statusCode = 204;
        response.end();
        return;
      }
    }
    next();
  });
  app.enableCors({
    origin: buildCorsOrigin(config, isProduction),
    credentials: true
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true
    })
  );
  setupSwagger(app);

  return app;
}

function buildCorsOrigin(config: ConfigService, isProduction: boolean) {
  // Shared with the OAuth redirect allow-list. Production used to have no
  // fallback here: every allowed origin came from API_ALLOWED_ORIGINS, so an
  // unset env var didn't degrade anything, it blocked every browser request.
  const allowedOrigins = buildAllowedOrigins(
    config.get<string>("API_ALLOWED_ORIGINS"),
    !isProduction,
  );

  return (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }

    callback(null, false);
  };
}

function setupSwagger(app: Awaited<ReturnType<typeof NestFactory.create>>) {
  const config = new DocumentBuilder()
    .setTitle("Prospera Sub API")
    .setDescription("Owned API for Prospera Sub cleaning packages, admin metrics, auth, and Blink Lightning payments.")
    .setVersion("0.1.0")
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);

  // Serverless (Vercel) doesn't serve @nestjs/swagger's bundled static assets, so
  // the default /docs page renders blank. Serve the spec as JSON and load Swagger
  // UI from a CDN instead — works reliably in serverless.
  const httpAdapter = app.getHttpAdapter();
  httpAdapter.get("/docs-json", (_req: unknown, res: any) => res.json(document));
  httpAdapter.get("/docs", (_req: unknown, res: any) => {
    res.type("text/html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ProsperaSub API</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body style="margin:0">
  <div id="app"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({ url: "/docs-json", dom_id: "#app", persistAuthorization: true });
  </script>
</body>
</html>`);
  });
}
