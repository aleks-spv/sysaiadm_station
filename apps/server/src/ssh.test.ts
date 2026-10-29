import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { type AuthContext, type Connection, Server } from "ssh2";
import { execRemote, HostKeyMismatch, SshHopError, toExecCommand, type Hop } from "./ssh";

const pem = () =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;

const PASSWORD = "pw";

// Clients that reject a host key drop the connection mid-handshake; that is expected here.
function authenticate(client: Connection) {
  client.on("error", () => {});
  client.on("authentication", (ctx: AuthContext) => {
    if (ctx.method === "password" && ctx.username === "root" && ctx.password === PASSWORD) ctx.accept();
    else ctx.reject();
  });
}

const target = new Server({ hostKeys: [pem()] }, (client) => {
  authenticate(client);
  client.on("ready", () => {
    client.on("session", (accept) => {
      accept().on("exec", (acceptExec, _reject, info) => {
        const stream = acceptExec();
        if (info.command === "echo hi") {
          stream.write("hi\n");
          stream.exit(0);
          stream.end();
        } else if (info.command === "big") {
          stream.write(Buffer.alloc(1024 * 1024, "a"));
          stream.exit(0);
          stream.end();
        }
        // "sleep" never answers: the abort test relies on that.
      });
    });
  });
});

// The bastion accepts only direct-tcpip requests and relays them to the target.
const bastion = new Server({ hostKeys: [pem()] }, (client) => {
  authenticate(client);
  client.on("tcpip", (accept, reject, info) => {
    const sock = net.connect(info.destPort, info.destIP);
    sock.on("connect", () => {
      const channel = accept();
      channel.pipe(sock).pipe(channel);
    });
    sock.on("error", () => reject());
  });
});

let targetPort = 0;
let bastionPort = 0;

beforeAll(async () => {
  await Promise.all([
    new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => bastion.listen(0, "127.0.0.1", resolve)),
  ]);
  targetPort = (target.address() as AddressInfo).port;
  bastionPort = (bastion.address() as AddressInfo).port;
});

afterAll(() => {
  target.close();
  bastion.close();
});

const hop = (port: number, knownHostKey: string | null = null): Hop => ({
  host: "127.0.0.1",
  port,
  user: "root",
  secret: { password: PASSWORD },
  knownHostKey,
});

test("direct exec returns stdout and the pinned host key", async () => {
  const out = await execRemote({ hops: [hop(targetPort)], command: "echo hi", shell: "bash" });
  expect(out.stdout).toBe("hi\n");
  expect(out.exitCode).toBe(0);
  expect(out.hostKeys).toHaveLength(1);
});

test("exec through a bastion returns one host key per hop", async () => {
  const first = await execRemote({ hops: [hop(bastionPort), hop(targetPort)], command: "echo hi", shell: "bash" });
  expect(first.stdout).toBe("hi\n");
  expect(first.hostKeys).toHaveLength(2);

  const pinned = await execRemote({
    hops: [hop(bastionPort, first.hostKeys[0]), hop(targetPort, first.hostKeys[1])],
    command: "echo hi",
    shell: "bash",
  });
  expect(pinned.stdout).toBe("hi\n");
});

test("a wrong bastion key fails at hop 0", async () => {
  const err = await execRemote({
    hops: [hop(bastionPort, "SHA256:wrong"), hop(targetPort)],
    command: "echo hi",
    shell: "bash",
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(HostKeyMismatch);
  expect((err as HostKeyMismatch).hop).toBe(0);
});

test("a wrong target key fails at hop 1", async () => {
  const first = await execRemote({ hops: [hop(bastionPort), hop(targetPort)], command: "echo hi", shell: "bash" });
  const err = await execRemote({
    hops: [hop(bastionPort, first.hostKeys[0]), hop(targetPort, "SHA256:wrong")],
    command: "echo hi",
    shell: "bash",
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(HostKeyMismatch);
  expect((err as HostKeyMismatch).hop).toBe(1);
});

test("an unreachable hop is reported with its index", async () => {
  const err = await execRemote({ hops: [hop(1)], command: "echo hi", shell: "bash" }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SshHopError);
  expect((err as SshHopError).hop).toBe(0);
});

test("output over the cap is truncated to 256 KiB", async () => {
  const out = await execRemote({ hops: [hop(targetPort)], command: "big", shell: "bash" });
  expect(out.truncated).toBe(true);
  expect(out.stdout.length).toBeLessThanOrEqual(256 * 1024);
});

test("abort returns in under two seconds", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  const err = await execRemote({
    hops: [hop(targetPort)],
    command: "sleep 10",
    shell: "bash",
    signal: controller.signal,
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toBe("ABORTED");
  expect(Date.now() - started).toBeLessThan(2000);
});

test("powershell command is sent as UTF-16LE base64", () => {
  const cmd = toExecCommand("powershell", "Get-Date");
  const encoded = cmd.split("-EncodedCommand ")[1];
  expect(cmd.startsWith("powershell -NoProfile -NonInteractive -EncodedCommand ")).toBe(true);
  expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe("Get-Date");
});
