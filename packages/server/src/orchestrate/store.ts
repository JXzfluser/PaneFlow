import fs from 'node:fs';
import path from 'node:path';
import type { DagGraph, RunRecord } from '@paneflow/shared';
import type { SpaceRule } from './rules.js';

export interface SpaceProfile {
  id: string;
  name: string;
  createdAt: string;
  /** 主仓根（仓库/文档/技能发现的基准路径） */
  rootCwd?: string;
  description?: string;
  /** 约定文档（相对主仓根，运行时注入 Agent 上下文）；M3 起被 rules 兼容吸收（迁移为无作用域条目） */
  conventionFiles?: string[];
  /** M3 作用域规范条目（配置文件管理，无编辑器）：{repo?, pathsGlob?, file, note?} */
  rules?: SpaceRule[];
  /** 技能清单（相对主仓根） */
  skills?: string[];
  /** 已登记仓库（相对主仓根，含 .git 的子目录）；M3 后作用域挂载点在 rules[].repo（目录名同源） */
  repos?: string[];
  /** 智能下发 Planner 用的 agent 类型（E'：取代写死 claude；非法/缺省时回落默认值） */
  defaultAgentKind?: string;
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

  /** 全量列出（R5.2 解除 50 条截断）；归档记录移入 archive/ 子目录后不再出现 */
  listRuns(): RunRecord[] {
    return fs
      .readdirSync(this.runsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this.readJson<RunRecord>(path.join(this.runsDir, f)))
      .filter((r): r is RunRecord => r !== null)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** R5.1 归档：移入 archive/ 子目录（记录保留、可检索） */
  archiveRun(runId: string): boolean {
    const src = this.runPath(runId);
    if (!fs.existsSync(src)) return false;
    const archiveDir = path.join(this.runsDir, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.renameSync(src, path.join(archiveDir, `${runId}.json`));
    return true;
  }

  listArchivedRuns(): RunRecord[] {
    const archiveDir = path.join(this.runsDir, 'archive');
    if (!fs.existsSync(archiveDir)) return [];
    return fs
      .readdirSync(archiveDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this.readJson<RunRecord>(path.join(archiveDir, f)))
      .filter((r): r is RunRecord => r !== null)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  getRun(runId: string): RunRecord | null {
    return this.readJson<RunRecord>(this.runPath(runId));
  }

  /** R5.1 归档记录读取 */
  getArchivedRun(runId: string): RunRecord | null {
    const p = path.join(this.runsDir, 'archive', `${runId}.json`);
    return this.readJson<RunRecord>(p);
  }

  /** v7-A2 反归档：archive/<id>.json 移回主目录并清归档标记，返回恢复后的记录 */
  unarchiveRun(runId: string): RunRecord | null {
    const rec = this.getArchivedRun(runId);
    if (!rec) return null;
    rec.archived = false;
    fs.writeFileSync(this.runPath(runId), JSON.stringify(rec, null, 2));
    fs.rmSync(path.join(this.runsDir, 'archive', `${runId}.json`));
    return rec;
  }

  /** v7-A2 真删除：仅删 archive/ 下的记录文件，主列表记录不受影响 */
  deleteArchivedRun(runId: string): boolean {
    const p = path.join(this.runsDir, 'archive', `${runId}.json`);
    if (!fs.existsSync(p)) return false;
    fs.rmSync(p);
    return true;
  }

  saveRun(run: RunRecord): void {
    if (run.archived) {
      const archiveDir = path.join(this.runsDir, 'archive');
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(path.join(archiveDir, `${run.runId}.json`), JSON.stringify(run, null, 2));
      const main = this.runPath(run.runId);
      if (fs.existsSync(main)) fs.rmSync(main);
      return;
    }
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
