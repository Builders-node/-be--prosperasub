import "reflect-metadata";
import { createNestApp } from "../src/bootstrap";

let cachedServer: any;

export default async function handler(request: unknown, response: unknown) {
  if (!cachedServer) {
    const app = await createNestApp();
    await app.init();
    cachedServer = app.getHttpAdapter().getInstance();
  }

  return cachedServer(request, response);
}
