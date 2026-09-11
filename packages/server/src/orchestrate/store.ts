import fs from 'node:fs';
import path from 'node:path';
import type { DagGraph, RunRecord } from '@paneflow/shared';

export interface SpaceProfile {
  id: string;
  name: string;
  createdAt: string;
  /** 主仓根（Space 属性，A2 骨架字段；P1 项目档案在此基础上扩展） */
  rootCwd?: string;
  description?: string;
}

export const DEFAULT_SPACE = 'default';

/**
 * Space-aware JSON persistence: `<root>/spaces/<spaceId>/{templates,runs}`.
 * Legacy flat layout (root/templates, root/runs) is auto-migrated into the
 * default space on first construction.
 */
export class Store {
  readonly root: string;
  readonly spaceId: string;
  private readonly templatesDir: string;
  private readonly runsDir: string;

  constructor(dataDir: string, spaceId: string = DEFAULT_SPACE) {
    this.root = dataDir;
    this.spaceId = spaceId;
    Store.migrateLegacy(dataDir);
    const spaceDir = this.spaceDir(dataDir, spaceId);
    this.templatesDir = path.join(spaceDir, 'templates');
    this.runsDir = path.join(spaceDir, 'runs');
    fs.mkdirSync(this.templatesDir, { recursive: true });
    fs.mkdirSync(this.runsDir, { recursive: true });
    if (!fs.existsSync(this.profilePath)) {
      this.writeProfile({
        id: spaceId,
        name: spaceId === DEFAULT_SPACE ? '默认空间' : spaceId,
        createdAt: new Date().toISOString(),
      });
    }
  }

  // -- spaces ------------------------------------------------------------------

  private get profilePath(): string {
    return path.join(this.spaceDir(this.root, this.spaceId), 'profile.json');
  }

  private spaceDir(root: string, spaceId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(spaceId)) throw new Error(`非法空间 ID：${spaceId}`);
    return path.join(root, 'spaces', spaceId);
  }

  static listSpaces(dataDir: string): SpaceProfile[] {
    const dir = path.join(dataDir, 'spaces');
    Store.migrateLegacy(dataDir);
    if (!fs.existsSync(dir)) return [];
    const out: SpaceProfile[] = [];
    for (const id of fs.readdirSync(dir)) {
      const p = path.join(dir, id, 'profile.json');
      try {
        out.push(JSON.parse(fs.readFileSync(p, 'utf8')) as SpaceProfile);
      } catch {
        out.push({ id, name: id, createdAt: '' });
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  static createSpace(dataDir: string, id: string, name: string): SpaceProfile {
    // constructing a Store materializes dirs + profile
    new Store(dataDir, id);
    const p = path.join(dataDir, 'spaces', id, 'profile.json');
    const profile = JSON.parse(fs.readFileSync(p, 'utf8')) as SpaceProfile;
    profile.name = name;
    fs.writeFileSync(p, JSON.stringify(profile, null, 2));
    return profile;
  }

  /** One-time move of legacy flat layout into the default space. */
  static migrateLegacy(dataDir: string): void {
    const legacyTemplates = path.join(dataDir, 'templates');
    const legacyRuns = path.join(dataDir, 'runs');
    const target = path.join(dataDir, 'spaces', DEFAULT_SPACE);
    if (!fs.existsSync(legacyTemplates) && !fs.existsSync(legacyRuns)) return;
    if (fs.existsSync(path.join(dataDir, 'spaces'))) return; // already migrated
    fs.mkdirSync(path.join(target, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(target, 'runs'), { recursive: true });
    if (fs.existsSync(legacyTemplates)) {
      for (const f of fs.readdirSync(legacyTemplates)) {
        fs.renameSync(path.join(legacyTemplates, f), path.join(target, 'templates', f));
      }
      fs.rmdirSync(legacyTemplates);
    }
    if (fs.existsSync(legacyRuns)) {
      for (const f of fs.readdirSync(legacyRuns)) {
        fs.renameSync(path.join(legacyRuns, f), path.join(target, 'runs', f));
      }
      fs.rmdirSync(legacyRuns);
    }
  }

  readProfile(): SpaceProfile {
    return JSON.parse(fs.readFileSync(this.profilePath, 'utf8')) as SpaceProfile;
  }

  writeProfile(profile: SpaceProfile): void {
    fs.writeFileSync(this.profilePath, JSON.stringify(profile, null, 2));
  }

  // -- graphs (templates) -----------------------------------------------------

  listGraphs(): DagGraph[] {
    return fs
      .readdirSync(this.templatesDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this.readJson<DagGraph>(path.join(this.templatesDir, f)))
      .filter((g): g is DagGraph => g !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getGraph(id: string): DagGraph | null {
    return this.readJson<DagGraph>(this.graphPath(id));
  }

  saveGraph(graph: DagGraph): void {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(graph.name)) {
      throw new Error(`模板名只能包含字母/数字/-/_：${graph.name}`);
    }
    graph.metadata.updatedAt = new Date().toISOString();
    if (!graph.metadata.createdAt) graph.metadata.createdAt = graph.metadata.updatedAt;
    fs.writeFileSync(this.graphPath(graph.name), JSON.stringify(graph, null, 2));
  }

  deleteGraph(id: string): boolean {
    const p = this.graphPath(id);
    if (fs.existsSync(p)) {
      fs.rmSync(p);
      return true;
    }
    return false;
  }

  private graphPath(id: string): string {
    return path.join(this.templatesDir, `${id}.json`);
  }

  // -- runs -------------------------------------------------------------------

  listRuns(): RunRecord[] {
    return fs
      .readdirSync(this.runsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this.readJson<RunRecord>(path.join(this.runsDir, f)))
      .filter((r): r is RunRecord => r !== null)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 50);
  }

  getRun(runId: string): RunRecord | null {
    return this.readJson<RunRecord>(this.runPath(runId));
  }

  saveRun(run: RunRecord): void {
    fs.writeFileSync(this.runPath(run.runId), JSON.stringify(run, null, 2));
  }

  deleteRun(runId: string): boolean {
    const p = this.runPath(runId);
    if (fs.existsSync(p)) {
      fs.rmSync(p);
      return true;
    }
    return false;
  }

  private runPath(runId: string): string {
    return path.join(this.runsDir, `${runId}.json`);
  }

  private readJson<T>(p: string): T | null {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
    } catch {
      return null;
    }
  }
}
