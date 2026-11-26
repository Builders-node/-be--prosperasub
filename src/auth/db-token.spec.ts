import { ConfigService } from "@nestjs/config";
import { AuthService } from "./auth.service";
import { PasswordService } from "./password.service";
import { SessionService } from "./session.service";

describe("AuthService.dbTokenFromAccessToken", () => {
  const env = {
    JWT_ACCESS_SECRET: "test-access-secret-0123456789abcdef0123",
    JWT_REFRESH_SECRET: "test-refresh-secret-0123456789abcdef012",
    SUPABASE_JWT_SECRET: "db-secret-for-tests-0123456789abcdef",
    SUPABASE_URL: "https://db.test",
    SUPABASE_ANON_KEY: "anon",
  };
  const make = (extra: Record<string, string> = {}) => {
    const config = new ConfigService({ ...env, ...extra });
    const sessions = new SessionService(config);
    return { sessions, auth: new AuthService(new PasswordService(), sessions, config, {} as any) };
  };
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it("issues a token once PostgREST accepts it, and checks only once", async () => {
    const { sessions, auth } = make();
    const fetchMock = jest.fn(async () => new Response("[]", { status: 200 }));
    global.fetch = fetchMock as any;
    const { accessToken } = await sessions.createTokenPair({ userId: "u1", roles: ["USER"] });
    const out = await auth.dbTokenFromAccessToken(accessToken);
    expect(out.access_token).toMatch(/^eyJ/);
    await auth.dbTokenFromAccessToken(accessToken);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("answers 503 when PostgREST rejects the token (wrong secret)", async () => {
    const { sessions, auth } = make();
    global.fetch = jest.fn(async () => new Response("{}", { status: 401 })) as any;
    const { accessToken } = await sessions.createTokenPair({ userId: "u1", roles: ["USER"] });
    await expect(auth.dbTokenFromAccessToken(accessToken)).rejects.toMatchObject({ status: 503 });
  });

  it("answers 503 when the secret is not configured", async () => {
    const { sessions, auth } = make({ SUPABASE_JWT_SECRET: "" });
    const { accessToken } = await sessions.createTokenPair({ userId: "u1", roles: ["USER"] });
    await expect(auth.dbTokenFromAccessToken(accessToken)).rejects.toMatchObject({ status: 503 });
  });

  it("rejects a bad session token with 401", async () => {
    const { auth } = make();
    await expect(auth.dbTokenFromAccessToken("nope")).rejects.toMatchObject({ status: 401 });
  });
});
