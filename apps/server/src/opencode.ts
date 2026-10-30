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

const PAGE = 200;
const MAX_PAGES = 50;

// The whole history, oldest first. Not session.context: that is the model's context window, which lags
// behind the newest message and is empty right after a compaction.
export async function messages(client: OpenCodeClient, sessionID: string) {
  const all: Awaited<ReturnType<OpenCodeClient["message"]["list"]>>["data"] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    // The cursor carries the order; opencode refuses both together.
    const res = await client.message.list(cursor ? { sessionID, limit: PAGE, cursor } : { sessionID, order: "asc", limit: PAGE });
    all.push(...res.data);
    cursor = res.cursor.next ?? undefined;
    if (res.data.length < PAGE || !cursor) break;
  }
  return all;
}

// The newest `limit` messages, oldest first: what a live chat refreshes instead of the whole history.
export async function recentMessages(client: OpenCodeClient, sessionID: string, limit: number) {
  const res = await client.message.list({ sessionID, order: "desc", limit });
  return res.data.reverse();
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

// Questions from the agent's question tool: opencode V2 calls them forms. list() returns the pending ones.
export async function listForms(client: OpenCodeClient, sessionID: string) {
  return client.session.form.list({ sessionID });
}

export type FormAnswer = Record<string, string | number | boolean | string[]>;

export async function replyForm(client: OpenCodeClient, sessionID: string, formID: string, answer: FormAnswer) {
  return client.session.form.reply({ sessionID, formID, answer });
}

export async function cancelForm(client: OpenCodeClient, sessionID: string, formID: string, message: string) {
  return client.session.form.cancel({ sessionID, formID, message });
}
