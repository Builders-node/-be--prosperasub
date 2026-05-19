import cookieParser from "cookie-parser";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";

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
  const configured = (config.get<string>("API_ALLOWED_ORIGINS") || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  const allowedOrigins = new Set(configured);

  if (!isProduction) {
    allowedOrigins.add("http://localhost:8080");
    allowedOrigins.add("http://127.0.0.1:8080");
    allowedOrigins.add("http://localhost:8081");
    allowedOrigins.add("http://127.0.0.1:8081");
  }

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
    .setDescription("Owned API for Prospera Sub meal plans, cleaning packages, admin metrics, auth, and Blink Lightning payments.")
    .setVersion("0.1.0")
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("docs", app, document, {
    jsonDocumentUrl: "docs-json",
    swaggerOptions: {
      persistAuthorization: true
    }
  });
}
