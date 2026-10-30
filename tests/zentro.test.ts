import { CompactEncrypt, compactDecrypt, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ZENTRO_MIN_DEPOSIT_USD, ZentroClient, ZentroError, type ZentroSession, type ZentroTransaction } from "@/lib/zentro/client";
import { checkBridge, MATCH_WINDOW_MS, matchPurchase, merchantPattern } from "@/lib/zentro/reconcile";
import { receiptFixture } from "./fixtures";

/* ------------------------------------------------------------------ */
/* Fake CardHub: the protocol as documented in src/lib/zentro/client.ts */
/* ------------------------------------------------------------------ */

const USER = { username: "ops@example.test", password: "correct horse" };

interface FakeHub {
  server: Server;
  baseUrl: string;
  /** sid → client public key registered via /setup (null until registered). */
  sessions: Map<string, JWK | null>;
  logins: number;
  /** Decrypted bodies of every /transfer call. */
  transfers: Record<string, unknown>[];
  serverKid: string;
  /** When set, /setup answers 200 but does not register the key: every data call then 403s. */
  dropSetup: boolean;
  /** When set, /setup answers 403. */
  rejectSetup: boolean;
}

async function startHub(): Promise<FakeHub> {
  const { publicKey, privateKey } = await generateKeyPair("ECDH-ES", { crv: "X25519", extractable: true });
  const serverKid = "srv-" + crypto.randomUUID();
  const serverPub = { ...(await exportJWK(publicKey)), kid: serverKid };
  const hub: FakeHub = { server: undefined as unknown as Server, baseUrl: "", sessions: new Map(), logins: 0, transfers: [], serverKid, dropSetup: false, rejectSetup: false };
  let nextSid = 1;

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => resolve(s));
    });
  const decryptBody = async (req: IncomingMessage) => {
    const hex = await readBody(req);
    const { plaintext } = await compactDecrypt(Buffer.from(hex, "hex").toString("utf8"), privateKey);
    return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown> & { clientPublicKey: JWK };
  };
  const sendEncrypted = async (res: ServerResponse, clientJwk: JWK, status: number, payload: unknown) => {
    const jwe = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify(payload)))
      .setProtectedHeader({ alg: "ECDH-ES+A256KW", enc: "A256GCM" })
      .encrypt(await importJWK(clientJwk, "ECDH-ES"));
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(Buffer.from(jwe, "utf8").toString("hex"));
  };
  const sendJson = (res: ServerResponse, status: number, payload: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  hub.server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const route = url.pathname.replace(/^\/dash\/api\/v1\//, "");
    if (route === "init") return sendJson(res, 200, { publicKey: serverPub });
    if (route === "auth") {
      const body = await decryptBody(req);
      if (body.username !== USER.username || body.password !== USER.password) return sendJson(res, 401, { error: "Invalid credentials" });
      const sid = `s${nextSid++}.sig`;
      hub.sessions.set(sid, null);
      hub.logins++;
      res.setHeader("set-cookie", `connect.sid=${sid}; Path=/; HttpOnly`);
      return sendEncrypted(res, body.clientPublicKey, 200, { ok: true });
    }
    const sid = /connect\.sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    if (!sid || !hub.sessions.has(sid)) return sendJson(res, 401, { error: "Unauthorized" });
    if (route === "setup") {
      if (hub.rejectSetup) return sendJson(res, 403, { error: "Key registration refused" });
      const body = await decryptBody(req);
      if (!hub.dropSetup) hub.sessions.set(sid, body.publicKey as JWK);
      return sendJson(res, 200, { ok: true });
    }
    const clientJwk = hub.sessions.get(sid);
    if (!clientJwk) return sendJson(res, 403, { error: "Key not registered" });
    if (route === "state") return sendEncrypted(res, clientJwk, 200, { user: { email: USER.username } });
    if (route === "list") return sendEncrypted(res, clientJwk, 200, { cards: [{ id: "card_1", last4: "4242", status: "active" }] });
    if (route === "target") return sendEncrypted(res, clientJwk, 200, { depositAddress: "BaseDeposit111" });
    if (route === "transfer" && req.method === "POST") {
      const body = await decryptBody(req);
      hub.transfers.push(body);
      return sendEncrypted(res, clientJwk, 200, { bridge_id: `br_${hub.transfers.length}`, deposit_address: "OneTime222", amount_to_send: String(body.amount), currency: body.currency, expected_usdc: body.amount, expires_in_seconds: 900 });
    }
    if (route.startsWith("transfer/")) return sendEncrypted(res, clientJwk, 200, { status: route === "transfer/br_1" ? "completed" : "unknown" });
    if (route === "history") return sendEncrypted(res, clientJwk, 200, [{ id: "t1", date: "2026-09-20T10:00:00Z", merchant: "GOFUNDME*X", amount: "25.00", kind: "purchase", type: "debit" }]);
    return sendJson(res, 404, { error: `no route ${route}` });
  });
  await new Promise<void>((r) => hub.server.listen(0, "127.0.0.1", r));
  hub.baseUrl = `http://127.0.0.1:${(hub.server.address() as AddressInfo).port}`;
  return hub;
}

let hub: FakeHub;
beforeAll(async () => {
  hub = await startHub();
});
afterAll(async () => {
  await new Promise<void>((r) => hub.server.close(() => r()));
});
beforeEach(() => {
  hub.sessions.clear();
  hub.logins = 0;
  hub.transfers = [];
  hub.dropSetup = false;
  hub.rejectSetup = false;
});

describe("ZentroClient", () => {
  it("login sets the cookie, registers the freshly generated key, and reports the session", async () => {
    const onSession = vi.fn();
    const c = new ZentroClient({ credentials: USER, onSession, baseUrl: hub.baseUrl });
    expect(c.hasSession).toBe(false);
    const s = await c.login();
    expect(c.hasSession).toBe(true);
    expect(hub.sessions.has(s.cookie)).toBe(true);
    expect(hub.sessions.get(s.cookie)?.kid).toBe(s.publicJwk.kid);
    expect(hub.sessions.get(s.cookie)?.x).toBe(s.publicJwk.x);
    expect(s.serverJwk.kid).toBe(hub.serverKid);
    expect(s.privateJwk.d).toBeTruthy();
    expect(onSession).toHaveBeenCalledWith(s);
    expect(hub.logins).toBe(1);
  });

  it("rejects bad credentials with the server's message", async () => {
    const c = new ZentroClient({ credentials: { username: USER.username, password: "nope" }, baseUrl: hub.baseUrl });
    await expect(c.login()).rejects.toMatchObject({ name: "ZentroError", status: 401, message: "Invalid credentials", path: "auth" });
    expect(c.hasSession).toBe(false);
  });

  it("encrypts request bodies the server can read and decrypts encrypted responses", async () => {
    const c = new ZentroClient({ credentials: USER, baseUrl: hub.baseUrl });
    expect(await c.state()).toEqual({ user: { email: USER.username } });
    expect((await c.cards())[0]).toMatchObject({ id: "card_1", last4: "4242" });
    const bridge = await c.createDeposit(25.129, "SOL-USDC");
    expect(hub.transfers).toEqual([expect.objectContaining({ amount: 25.13, currency: "SOL-USDC", baseAddress: "BaseDeposit111" })]);
    expect(bridge).toMatchObject({ bridge_id: "br_1", deposit_address: "OneTime222", amount_to_send: "25.13", expires_in_seconds: 900 });
    expect((await c.depositStatus("br_1")).status).toBe("completed");
    expect((await c.history("card_1"))[0]).toMatchObject({ id: "t1", amount: "25.00" });
  });

  it("refuses deposits under the Zentro minimum without touching the server", async () => {
    const c = new ZentroClient({ credentials: USER, baseUrl: hub.baseUrl });
    await expect(c.createDeposit(ZENTRO_MIN_DEPOSIT_USD - 0.01)).rejects.toBeInstanceOf(ZentroError);
    await expect(c.createDeposit(Number.NaN)).rejects.toBeInstanceOf(ZentroError);
    expect(hub.logins).toBe(0);
    expect(hub.transfers).toEqual([]);
  });

  it("re-logs in once when the session is rejected and credentials are present", async () => {
    const onSession = vi.fn();
    const c = new ZentroClient({ credentials: USER, onSession, baseUrl: hub.baseUrl });
    await c.state();
    const first = c.exportSession()!;
    hub.sessions.clear(); // server-side expiry
    expect(await c.state()).toEqual({ user: { email: USER.username } });
    const second = c.exportSession()!;
    expect(hub.logins).toBe(2);
    expect(second.cookie).not.toBe(first.cookie);
    expect(second.publicJwk.kid).not.toBe(first.publicJwk.kid);
    expect(onSession).toHaveBeenCalledTimes(2);
  });

  it("surfaces ZentroError when the session is rejected and there are no credentials", async () => {
    const seed = new ZentroClient({ credentials: USER, baseUrl: hub.baseUrl });
    await seed.state();
    const imported: ZentroSession = seed.exportSession()!;
    hub.sessions.clear();
    const c = new ZentroClient({ session: imported, baseUrl: hub.baseUrl });
    expect(c.canLogin).toBe(false);
    await expect(c.state()).rejects.toMatchObject({ name: "ZentroError", status: 401, message: "Unauthorized", path: "state" });
    expect(hub.logins).toBe(1);
    await expect(new ZentroClient({ baseUrl: hub.baseUrl }).state()).rejects.toBeInstanceOf(ZentroError);
  });

  it("gives up after one re-login when the renewed session is still rejected", async () => {
    const c = new ZentroClient({ credentials: USER, baseUrl: hub.baseUrl });
    await c.state();
    hub.sessions.clear();
    hub.dropSetup = true;
    await expect(c.state()).rejects.toMatchObject({ name: "ZentroError", status: 403, path: "state" });
    expect(hub.logins).toBe(2);
  });

  it("fails (instead of hanging on its own login) when key registration is refused", async () => {
    hub.rejectSetup = true;
    const c = new ZentroClient({ credentials: USER, baseUrl: hub.baseUrl });
    await expect(c.state()).rejects.toMatchObject({ name: "ZentroError", status: 403, message: "Key registration refused", path: "setup" });
    expect(hub.logins).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Purchase matching                                                    */
/* ------------------------------------------------------------------ */

describe("matchPurchase", () => {
  const funded = new Date("2026-09-20T10:00:00Z");
  const tx = (over: Partial<ZentroTransaction>): ZentroTransaction => ({ id: "t", date: "2026-09-20T12:00:00Z", merchant: "GOFUNDME*HOPEWARD", amount: "100.00", kind: "purchase", type: "debit", ...over });
  const delivery = { amountUsdc: 100, fundedAt: funded };
  const gofundme = { platform: "gofundme" as const, url: "https://www.gofundme.com/f/hope-ward" };

  it("picks the platform purchase after funding that is closest in amount, earliest on ties", () => {
    const history = [
      tx({ id: "before", date: "2026-09-20T09:59:59Z" }),
      tx({ id: "far", amount: "102.50" }),
      tx({ id: "later-exact", date: "2026-09-21T00:00:00Z", amount: "100.00" }),
      tx({ id: "exact", amount: "-100.00", sign: -1 }),
      tx({ id: "near", amount: "100.80" }),
    ];
    const m = matchPurchase(delivery, gofundme, history)!;
    expect(m.id).toBe("exact");
    expect(m.amountUsd).toBe(100);
    expect(m.merchant).toBe("GOFUNDME*HOPEWARD");
    expect(m.at.toISOString()).toBe("2026-09-20T12:00:00.000Z");
  });

  it("rejects the wrong merchant, wrong amount, pre-funding date, declined, and non-purchase lines", () => {
    expect(matchPurchase(delivery, gofundme, [tx({ merchant: "LAUNCHGOOD" })])).toBeNull();
    expect(matchPurchase(delivery, gofundme, [tx({ merchant: undefined, description: "Amazon" })])).toBeNull();
    expect(matchPurchase(delivery, gofundme, [tx({ amount: "104.00" })])).toBeNull();
    expect(matchPurchase(delivery, gofundme, [tx({ date: "2026-09-20T10:00:00Z" })])).toBeNull();
    expect(matchPurchase(delivery, gofundme, [tx({ date: "not a date" })])).toBeNull();
    expect(matchPurchase(delivery, gofundme, [tx({ status: "DECLINED" })])).toBeNull();
    expect(matchPurchase(delivery, gofundme, [tx({ status: "reversed" })])).toBeNull();
    expect(matchPurchase(delivery, gofundme, [tx({ kind: "refund" })])).toBeNull();
    expect(matchPurchase(delivery, gofundme, [tx({ kind: undefined })])).toBeNull();
  });

  it("never matches a line whose amount does not parse, and does not let it shadow a real match", () => {
    expect(matchPurchase(delivery, gofundme, [tx({ amount: "$100.00" })])).toBeNull();
    expect(matchPurchase(delivery, gofundme, [tx({ id: "junk", amount: "n/a" }), tx({ id: "real", amount: "100.00" })])?.id).toBe("real");
  });

  it("only matches inside (fundedAt, fundedAt + 7d] and never before funding is known", () => {
    const edge = new Date(funded.getTime() + MATCH_WINDOW_MS);
    expect(matchPurchase(delivery, gofundme, [tx({ date: edge.toISOString() })])).not.toBeNull();
    expect(matchPurchase(delivery, gofundme, [tx({ date: new Date(edge.getTime() + 1).toISOString() })])).toBeNull();
    expect(matchPurchase({ amountUsdc: 100, fundedAt: null }, gofundme, [tx({})])).toBeNull();
  });

  it("skips card transactions already attached to another delivery", () => {
    const history = [tx({ id: "used", amount: "100.00" }), tx({ id: "free", amount: "101.00" })];
    expect(matchPurchase(delivery, gofundme, history)?.id).toBe("used");
    expect(matchPurchase(delivery, gofundme, history, new Set(["used"]))?.id).toBe("free");
    expect(matchPurchase(delivery, gofundme, history, new Set(["used", "free"]))).toBeNull();
    // Lines without an issuer id are identified by chain hash, else by date|merchant|amount.
    const anon = tx({ id: undefined, txHash: "0xabc" });
    expect(matchPurchase(delivery, gofundme, [anon])?.id).toBe("0xabc");
    const bare = tx({ id: undefined });
    expect(matchPurchase(delivery, gofundme, [bare])?.id).toBe("2026-09-20T12:00:00Z|GOFUNDME*HOPEWARD|100.00");
  });

  it("tolerates max($1, 3%) — inclusive at the boundary, exclusive just past it", () => {
    // $100 → 3% = $3.
    expect(matchPurchase(delivery, gofundme, [tx({ amount: "103.00" })])).not.toBeNull();
    expect(matchPurchase(delivery, gofundme, [tx({ amount: "97.00" })])).not.toBeNull();
    expect(matchPurchase(delivery, gofundme, [tx({ amount: "103.01" })])).toBeNull();
    // $20 → 3% = $0.60, floor of $1 applies.
    const small = { amountUsdc: 20, fundedAt: funded };
    expect(matchPurchase(small, gofundme, [tx({ amount: "21.00" })])).not.toBeNull();
    expect(matchPurchase(small, gofundme, [tx({ amount: "19.00" })])).not.toBeNull();
    expect(matchPurchase(small, gofundme, [tx({ amount: "21.01" })])).toBeNull();
  });

  it("matches by description when merchant is absent", () => {
    expect(matchPurchase(delivery, gofundme, [tx({ merchant: undefined, description: "gofundme.com" })])?.merchant).toBe("gofundme.com");
  });
});

describe("merchantPattern", () => {
  it("uses the platform descriptor when known", () => {
    expect(merchantPattern({ platform: "everyorg", url: "https://x" }).test("EVERYORG DONATION")).toBe(true);
    expect(merchantPattern({ platform: "everyorg", url: "https://x" }).test("EVERY.ORG")).toBe(true);
    expect(merchantPattern({ platform: "gofundme", url: "https://www.gogetfunding.com/x" }).test("GOGETFUNDING")).toBe(false);
  });

  it("derives the descriptor from the cause URL's registrable label for unlisted platforms", () => {
    const other = merchantPattern({ platform: "other", url: "https://donate.chuffed.org/campaign/1" });
    expect(other.test("CHUFFED PTY LTD")).toBe(true);
    expect(other.test("SOME SHOP")).toBe(false);
    expect(merchantPattern({ platform: "other", url: "https://www.example.co.uk/x" }).test("EXAMPLE LTD")).toBe(true);
    const stripe = merchantPattern({ platform: "stripe_link", url: "https://buy.stripe.com/abc" });
    expect(stripe.test("STRIPE *CLINIC")).toBe(true);
    const stripeOwn = merchantPattern({ platform: "stripe_link", url: "https://pay.hospitalfund.org/x" });
    expect(stripeOwn.test("HOSPITALFUND")).toBe(true);
    expect(stripeOwn.test("STRIPE")).toBe(true);
    expect(stripeOwn.test("AMAZON")).toBe(false);
  });

  it("matches nothing when the URL is unusable, so an unknown merchant is never attributed", () => {
    const none = merchantPattern({ platform: "other", url: "not a url" });
    expect(none.test("")).toBe(false);
    expect(none.test("ANYTHING")).toBe(false);
    expect(matchPurchase({ amountUsdc: 100, fundedAt: new Date("2026-09-20T10:00:00Z") }, { platform: "other", url: "nope" }, [{ id: "t", date: "2026-09-20T12:00:00Z", merchant: "ANY", amount: "100", kind: "purchase" }])).toBeNull();
  });
});

describe("checkBridge", () => {
  it("never judges the invoice of a top-up whose own USDC transfer is unconfirmed, which could fail it as sent", async () => {
    // Zentro is not configured in tests: reaching the invoice poll would throw ZentroNotConfiguredError.
    const { delivery } = receiptFixture({ delivery: { status: "funding", bridgeStatus: "sending", fundingLastValidBlockHeight: 1_000, bridgeExpiresAt: new Date(0) } });
    const r = await checkBridge(delivery);
    expect(r.outcome).toBe("waiting");
    expect(r.delivery.status).toBe("funding");
  });
});
