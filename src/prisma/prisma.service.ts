import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private connectError: string | null = null;
  private connected = false;

  async onModuleInit() {
    if (process.env.NODE_ENV === "test" || process.env.SKIP_DATABASE_CONNECT === "true" || !process.env.DATABASE_URL) {
      return;
    }

    try {
      await this.$connect();
      this.connected = true;
      this.connectError = null;
      this.logger.log("Database connected successfully.");
    } catch (error) {
      this.connected = false;
      this.connectError = error instanceof Error ? error.message : "Database connection failed";
      this.logger.error(
        `Database connection failed during startup. DB-backed routes will be unavailable until DATABASE_URL is reachable. Error: ${this.connectError}`
      );
    }
  }

  async onModuleDestroy() {
    if (process.env.NODE_ENV === "test" || process.env.SKIP_DATABASE_CONNECT === "true" || !process.env.DATABASE_URL || !this.connected) {
      return;
    }

    await this.$disconnect();
  }

  isAvailable() {
    if (process.env.NODE_ENV === "test" || process.env.SKIP_DATABASE_CONNECT === "true" || !process.env.DATABASE_URL) {
      return false;
    }

    return this.connected && !this.connectError;
  }

  getConnectError() {
    return this.connectError;
  }
}
