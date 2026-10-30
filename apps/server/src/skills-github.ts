// Scans GitHub repositories for SKILL.md files (opencode/Anthropic skill layout).

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const REF = /^[A-Za-z0-9_./-]{1,200}$/;
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SKILL_BYTES = 256 * 1024;
const MAX_SKILLS = 100;
const TIMEOUT_MS = 15_000;

export interface RepoSpec {
  owner: string;
  repo: string;
  ref?: string;
  subdir?: string;
}

export interface ParsedSkill {
  path: string;
  id: string;
  name: string;
  description: string;
  content: string;
}

// Accepts `owner/repo`, `https://github.com/owner/repo[.git]`, `https://github.com/owner/repo/tree/<ref>/<subdir>`.
// Only github.com is accepted, so the server never fetches an admin-supplied host.
export function parseRepo(input: string): RepoSpec {
  const s = input.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const rest = /^https?:\/\/github\.com\//i.test(s) ? s.replace(/^https?:\/\/github\.com\//i, "") : s;
  if (rest.includes("://")) throw new Error("BAD_REPO");
  const [owner, repo, tree, ref, ...sub] = rest.split("/");
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo) || repo === "." || repo === "..") throw new Error("BAD_REPO");
  if (tree === undefined) return { owner, repo };
  if (tree !== "tree" || !ref || !REF.test(ref)) throw new Error("BAD_REPO");
  const subdir = sub.join("/") || undefined;
  if (subdir?.split("/").some((part) => part === ".." || part === "")) throw new Error("BAD_REPO");
  return { owner, repo, ref, subdir };
}

// Also used by syncBuiltinSkills. YAML folds long descriptions onto indented continuation lines; quotes are dropped.
export function frontmatter(content: string): { name: string; description: string } {
  const folded = /^description:[ \t]*(.*(?:\n[ \t]+.+)*)/m.exec(content)?.[1] ?? "";
  return {
    name: /^name:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? "",
    description: folded.replace(/\s+/g, " ").trim().replace(/^(["'])(.*)\1$/, "$2"),
  };
}

// The skill id is the SKILL.md parent directory name (or the repo name for a root SKILL.md).
export function skillIdFromPath(path: string, repo: string): string | null {
  const parts = path.split("/");
  const dir = parts.length > 1 ? parts[parts.length - 2] : repo;
  const id = dir.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return SKILL_ID.test(id) ? id : null;
}

function apiError(status: number): Error {
  if (status === 404) return new Error("репозиторий или ветка не найдены");
  if (status === 403 || status === 429) return new Error("лимит GitHub API, задайте GITHUB_TOKEN");
  return new Error(`GitHub API: HTTP ${status}`);
}

export async function scanRepo(
  fetchFn: typeof fetch,
  spec: RepoSpec & { githubToken?: string },
): Promise<{ ref: string; skills: ParsedSkill[] }> {
  const { owner, repo, subdir, githubToken } = spec;
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "sysadm" };
  if (githubToken) headers.authorization = `Bearer ${githubToken}`;
  const api = async (url: string) => {
    const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw apiError(res.status);
    return res.json() as Promise<Record<string, unknown>>;
  };

  let ref = spec.ref;
  if (!ref) {
    const info = await api(`https://api.github.com/repos/${owner}/${repo}`);
    ref = typeof info.default_branch === "string" ? info.default_branch : "main";
  }
  if (!REF.test(ref)) throw new Error("BAD_REPO");

  const tree = await api(`https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`);
  const paths = (Array.isArray(tree.tree) ? (tree.tree as Array<{ path?: unknown; type?: unknown }>) : [])
    .filter((n) => n.type === "blob" && typeof n.path === "string" && (n.path === "SKILL.md" || n.path.endsWith("/SKILL.md")))
    .map((n) => n.path as string)
    .filter((path) => !subdir || path.startsWith(`${subdir}/`))
    .slice(0, MAX_SKILLS);

  const skills: ParsedSkill[] = [];
  for (const path of paths) {
    const id = skillIdFromPath(path, repo);
    if (!id) continue;
    const res = await fetchFn(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`, {
      headers: { "user-agent": "sysadm" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`не удалось скачать ${path}: HTTP ${res.status}`);
    const body = await res.arrayBuffer();
    if (body.byteLength > MAX_SKILL_BYTES) continue;
    const content = new TextDecoder().decode(body);
    const meta = frontmatter(content);
    skills.push({ path, id, name: meta.name || id, description: meta.description, content });
  }
  return { ref, skills };
}
