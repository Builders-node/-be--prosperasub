/** Same allow-list as backend/src/config/app-origins.ts. */
const ALLOWED = new Set([
  "https://everysub.net",
  "https://www.everysub.net",
  "https://prosperasub.com",
  "https://www.prosperasub.com",
  "https://beachclub.everysub.net",
  "https://dev.everysub.net",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://localhost:8081",
  "http://127.0.0.1:8081",
]);

/** Vercel preview builds of the frontend (the dev branch and PRs). */
const PREVIEW = /^https:\/\/prospera-[a-z0-9-]+-frorexstudios-projects\.vercel\.app$/;

export function isAllowedOrigin(origin: string | undefined): origin is string {
  return !!origin && (ALLOWED.has(origin) || PREVIEW.test(origin));
}
