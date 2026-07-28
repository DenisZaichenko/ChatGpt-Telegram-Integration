import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { canonicalDirectory, isAllowedCanonicalPath, isInside } from "./security.js";
import { StateStore } from "./store.js";
import type { Project } from "./types.js";

export class ProjectRegistry {
  readonly roots: string[] = [];
  readonly parents: string[] = [];

  constructor(private readonly config: Config, private readonly store: StateStore) {}

  refresh(): Project[] {
    this.roots.splice(0);
    this.parents.splice(0);
    for (const candidate of this.config.projectRoots) this.roots.push(canonicalDirectory(candidate));
    for (const candidate of this.config.projectParentDirs) this.parents.push(canonicalDirectory(candidate));

    const aliasesByPath = new Map<string, string>();
    for (const [alias, candidate] of Object.entries(this.config.projectAliases)) {
      aliasesByPath.set(canonicalDirectory(candidate), normalizeAlias(alias));
    }

    for (const root of this.roots) {
      const alias = aliasesByPath.get(root) ?? this.uniqueAlias(path.basename(root), root);
      this.store.upsertProject(root, alias, aliasesByPath.has(root) ? "alias" : "explicit");
    }

    for (const parent of this.parents) this.discoverChildren(parent, parent, this.config.projectDiscoveryDepth);
    return this.store.listProjects();
  }

  isAllowed(candidate: string): boolean {
    return isAllowedCanonicalPath(candidate, this.roots, this.parents);
  }

  resolveProjectForCwd(cwd: string): Project | null {
    let canonical: string;
    try { canonical = canonicalDirectory(cwd); } catch { return null; }
    if (!this.isAllowed(canonical)) return null;

    const existing = this.store.listProjects()
      .filter((project) => isInside(canonical, project.canonicalPath))
      .sort((a, b) => b.canonicalPath.length - a.canonicalPath.length)[0];
    if (existing) return existing;

    const parent = this.parents.filter((item) => isInside(canonical, item)).sort((a, b) => b.length - a.length)[0];
    if (!parent) return null;
    const projectPath = findGitRoot(canonical, parent) ?? directChildOf(canonical, parent);
    if (!projectPath) return null;
    return this.store.upsertProject(projectPath, this.uniqueAlias(path.basename(projectPath), projectPath), "chat", parent);
  }

  recanonicalize(project: Project): string {
    const current = canonicalDirectory(project.canonicalPath);
    if (current !== project.canonicalPath || !this.isAllowed(current)) throw new Error("Project path is no longer within the allowlist");
    return current;
  }

  private discoverChildren(directory: string, allowedParent: string, depth: number): void {
    if (depth <= 0) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      const candidate = path.join(directory, entry.name);
      let canonical: string;
      try { canonical = canonicalDirectory(candidate); } catch { continue; }
      if (!isInside(canonical, allowedParent)) continue;
      if (fs.existsSync(path.join(canonical, ".git"))) {
        this.store.upsertProject(canonical, this.uniqueAlias(entry.name, canonical), "discovered", allowedParent);
      } else {
        this.discoverChildren(canonical, allowedParent, depth - 1);
      }
    }
  }

  private uniqueAlias(raw: string, canonicalPath: string): string {
    const base = normalizeAlias(raw);
    const existing = this.store.listProjects();
    const same = existing.find((project) => project.canonicalPath === canonicalPath);
    if (same) return same.alias;
    const used = new Set(existing.map((project) => project.alias));
    if (!used.has(base)) return base;
    for (let suffix = 2; ; suffix += 1) if (!used.has(`${base}-${suffix}`)) return `${base}-${suffix}`;
  }
}

function normalizeAlias(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "project";
}

function findGitRoot(start: string, boundary: string): string | null {
  let current = start;
  while (isInside(current, boundary)) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    if (current === boundary) break;
    current = path.dirname(current);
  }
  return null;
}

function directChildOf(candidate: string, parent: string): string | null {
  const relative = path.relative(parent, candidate);
  const first = relative.split(path.sep)[0];
  return first ? path.join(parent, first) : null;
}
