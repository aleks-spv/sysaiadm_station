import { describe, expect, test } from "bun:test";
import { parseRepo, scanRepo, skillIdFromPath } from "./skills-github";

describe("parseRepo", () => {
  test("accepts short and URL forms", () => {
    expect(parseRepo("anthropics/skills")).toEqual({ owner: "anthropics", repo: "skills" });
    expect(parseRepo("https://github.com/anthropics/skills.git/")).toEqual({ owner: "anthropics", repo: "skills" });
    expect(parseRepo("https://github.com/a/b/tree/dev/skills/x")).toEqual({ owner: "a", repo: "b", ref: "dev", subdir: "skills/x" });
  });

  test("rejects other hosts and traversal", () => {
    for (const bad of ["https://evil.com/a/b", "a", "a/b/blob/main", "https://github.com/a/b/tree/main/../x", "file:///etc/passwd"]) {
      expect(() => parseRepo(bad)).toThrow("BAD_REPO");
    }
  });
});

test("skillIdFromPath uses the parent directory", () => {
  expect(skillIdFromPath("skills/PDF Tools/SKILL.md", "r")).toBe("pdf-tools");
  expect(skillIdFromPath("SKILL.md", "my-repo")).toBe("my-repo");
});

test("scanRepo resolves the default branch and parses SKILL.md files", async () => {
  const urls: string[] = [];
  const fake = (async (url: string) => {
    urls.push(url);
    if (url.endsWith("/repos/o/r")) return Response.json({ default_branch: "main" });
    if (url.includes("/git/trees/main")) {
      return Response.json({ tree: [{ path: "a/SKILL.md", type: "blob" }, { path: "b/README.md", type: "blob" }, { path: "c/SKILL.md", type: "tree" }] });
    }
    if (url === "https://raw.githubusercontent.com/o/r/main/a/SKILL.md") return new Response("---\nname: Alpha\ndescription: does a\n---\nbody");
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;

  const result = await scanRepo(fake, { owner: "o", repo: "r" });
  expect(result.ref).toBe("main");
  expect(result.skills).toEqual([{ path: "a/SKILL.md", id: "a", name: "Alpha", description: "does a", content: "---\nname: Alpha\ndescription: does a\n---\nbody" }]);
  expect(urls).toHaveLength(3);
});

test("scanRepo maps rate limit to a readable error", async () => {
  const fake = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;
  await expect(scanRepo(fake, { owner: "o", repo: "r", ref: "main" })).rejects.toThrow("GITHUB_TOKEN");
});
