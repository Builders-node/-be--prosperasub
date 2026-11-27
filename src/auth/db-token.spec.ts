import { ConfigService } from "@nestjs/config";
import { AuthService } from "./auth.service";
import { PasswordService } from "./password.service";
import { SessionService } from "./session.service";

const UID = "11111111-2222-4333-8444-555555555555";
const decodeSub = (token: string) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub;

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
    const { accessToken } = await sessions.createTokenPair({ userId: UID, roles: ["USER"] });
    const out = await auth.dbTokenFromAccessToken(accessToken);
    expect(out.access_token).toMatch(/^eyJ/);
    await auth.dbTokenFromAccessToken(accessToken);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("answers 503 when PostgREST rejects the token (wrong secret)", async () => {
    const { sessions, auth } = make();
    global.fetch = jest.fn(async () => new Response("{}", { status: 401 })) as any;
    const { accessToken } = await sessions.createTokenPair({ userId: UID, roles: ["USER"] });
    await expect(auth.dbTokenFromAccessToken(accessToken)).rejects.toMatchObject({ status: 503 });
  });

  it("answers 503 when the secret is not configured", async () => {
    const { sessions, auth } = make({ SUPABASE_JWT_SECRET: "" });
    const { accessToken } = await sessions.createTokenPair({ userId: UID, roles: ["USER"] });
    await expect(auth.dbTokenFromAccessToken(accessToken)).rejects.toMatchObject({ status: 503 });
  });

  it("rejects a bad session token with 401", async () => {
    const { auth } = make();
    await expect(auth.dbTokenFromAccessToken("nope")).rejects.toMatchObject({ status: 401 });
  });

  it("mints a Google session's token for the account uuid, not the google- subject", async () => {
    const { sessions, auth } = make();
    global.fetch = jest.fn(async (url: any) =>
      String(url).includes("/rest/v1/users")
        ? new Response(JSON.stringify([{ id: UID }]), { status: 200 })
        : new Response("[]", { status: 200 })) as any;
    const { accessToken } = await sessions.createTokenPair({
      userId: "google-115528142777599499993", email: "a@b.co", roles: ["USER"],
    });
    const out = await auth.dbTokenFromAccessToken(accessToken);
    expect(decodeSub(out.access_token)).toBe(UID);
  });

  it("answers 503 rather than mint a google- subject it cannot resolve", async () => {
    const { sessions, auth } = make();
    global.fetch = jest.fn(async () => new Response("[]", { status: 200 })) as any;
    const { accessToken } = await sessions.createTokenPair({
      userId: "google-115528142777599499993", email: "a@b.co", roles: ["USER"],
    });
    await expect(auth.dbTokenFromAccessToken(accessToken)).rejects.toMatchObject({ status: 503 });
  });

  it("moves a Google session onto the account uuid on refresh", async () => {
    const { sessions, auth } = make();
    global.fetch = jest.fn(async () => new Response(JSON.stringify([{ id: UID }]), { status: 200 })) as any;
    const { refreshToken } = await sessions.createTokenPair({
      userId: "google-115528142777599499993", email: "a@b.co", roles: ["USER"], authProvider: "google",
    });
    const out = await auth.refresh(refreshToken);
    expect(out.user.id).toBe(UID);
    expect(decodeSub(out.session.access_token)).toBe(UID);
  });
});
