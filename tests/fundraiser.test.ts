import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchFundraiserPage } from "@/lib/ai/fundraiser";

/** The cause URL is attacker-typed and fetched server-side when an operator runs the fact check. */
describe("fetchFundraiserPage", () => {
  let server: Server;
  let port = 0;
  let hits = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "text/html" }).end("<title>internal</title>secret");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("never requests loopback, private, link-local or non-http targets", async () => {
    for (const url of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://[::ffff:127.0.0.1]:${port}/`, `http://2130706433:${port}/`, "http://169.254.169.254/latest/meta-data/", "http://192.168.0.1/", "file:///etc/passwd"]) {
      const page = await fetchFundraiserPage(url);
      expect(page.error, url).toMatch(/^Refused/);
      expect(page.text, url).toBe("");
    }
    expect(hits).toBe(0);
  });
});
