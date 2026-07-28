import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { ProjectRegistry } from "../src/projects.js";
import { StateStore } from "../src/store.js";

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("project discovery", () => {
  it("discovers git children and ignores symlinks escaping the parent", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "remote-projects-")); temporary.push(base);
    const parent = path.join(base, "parent"); const outside = path.join(base, "outside"); const data = path.join(base, "data");
    fs.mkdirSync(path.join(parent, "good", ".git"), { recursive: true }); fs.mkdirSync(path.join(outside, ".git"), { recursive: true });
    fs.symlinkSync(outside, path.join(parent, "escape"));
    const store = new StateStore(path.join(data, "state.db"));
    const config = { projectRoots: [], projectParentDirs: [parent], projectAliases: {}, projectDiscoveryDepth: 1 } as unknown as Config;
    const registry = new ProjectRegistry(config, store);
    expect(registry.refresh().map((project) => project.alias)).toEqual(["good"]);
    expect(registry.resolveProjectForCwd(outside)).toBeNull();
    store.close();
  });
});
