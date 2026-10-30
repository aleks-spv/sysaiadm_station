import { OpenCode, type SessionCreateInput, type SessionUpdateInput } from "@opencode/client";

// opencode serve takes its password from OPENCODE_SERVER_PASSWORD and expects HTTP Basic
// auth with the fixed username "opencode" (see @opencode/client service headers).
export const OPENCODE_USERNAME = "opencode";

export interface OpenCodeConfig {
  baseUrl: string;
  password: string;
}

export function authHeaders(password: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${OPENCODE_USERNAME}:${password}`).toString("base64")}` };
}

export function makeClient(config: OpenCodeConfig) {
  return OpenCode.make({ baseUrl: config.baseUrl, headers: authHeaders(config.password) });
}

export type OpenCodeClient = ReturnType<typeof makeClient>;
export type Permissions = NonNullable<SessionUpdateInput["permissions"]>;

export async function createSession(
  client: OpenCodeClient,
  directory: string,
  title: string,
  permissions?: Permissions,
  agent?: string,
) {
  const input: SessionCreateInput = { location: { directory }, title, permissions, agent };
  return client.session.create(input);
}

export async function prompt(client: OpenCodeClient, sessionID: string, text: string) {
  return client.session.prompt({ sessionID, text });
}

export async function interrupt(client: OpenCodeClient, sessionID: string) {
  return client.session.interrupt({ sessionID, resume: false });
}

export async function setPermissions(client: OpenCodeClient, sessionID: string, permissions: Permissions) {
  return client.session.update({ sessionID, permissions });
}

export async function removeSession(client: OpenCodeClient, sessionID: string) {
  return client.session.remove({ sessionID });
}

export async function listPending(client: OpenCodeClient, sessionID: string) {
  return client.permission.list({ sessionID });
}

export async function reply(
  client: OpenCodeClient,
  sessionID: string,
  requestID: string,
  decision: "once" | "always" | "reject",
) {
  return client.permission.reply({ sessionID, requestID, decision });
}

export async function messages(client: OpenCodeClient, sessionID: string) {
  return client.session.context({ sessionID });
}

export function events(client: OpenCodeClient, signal: AbortSignal) {
  return client.event.subscribe({ signal });
}

export async function providers(client: OpenCodeClient) {
  return client.provider.list();
}

export async function models(client: OpenCodeClient) {
  return client.model.list();
}

export async function agents(client: OpenCodeClient) {
  return client.agent.list();
}

export async function integrations(client: OpenCodeClient) {
  return client.integration.list();
}

export async function connectKey(client: OpenCodeClient, integrationID: string, key: string) {
  return client.integration.connect.key({ integrationID, key });
}

export async function setModel(client: OpenCodeClient, sessionID: string, providerID: string, modelID: string) {
  return client.session.switchModel({ sessionID, model: { providerID, id: modelID } });
}
