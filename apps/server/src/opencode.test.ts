import { expect, test } from "bun:test";
import { authHeaders, makeClient, OPENCODE_USERNAME } from "./opencode";

test("auth header is Basic opencode:<OPENCODE_SERVER_PASSWORD>", () => {
  const header = authHeaders("s3cret:with-colon").authorization;
  expect(header.startsWith("Basic ")).toBe(true);
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  expect(decoded).toBe(`${OPENCODE_USERNAME}:s3cret:with-colon`);
});

test("client builds without a network call", () => {
  const client = makeClient({ baseUrl: "http://127.0.0.1:4096", password: "pw" });
  expect(typeof client.session.create).toBe("function");
});
