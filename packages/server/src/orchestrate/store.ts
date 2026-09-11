import fs from 'node:fs';
import path from 'node:path';
import type { DagGraph, RunRecord } from '@paneflow/shared';

/**
 * File-based persistence: templates and run records as JSON under dataDir.
 * Chosen over SQLite for M1 to keep zero native deps; format is stable JSON
 * so a later migration is mechanical.
 */
export class Store {
  private readonly templatesDir: string;
  private readonly runsDir: string;

  constructor(dataDir: string) {
    this.templatesDir = path.join(dataDir, 'templates');
    this.runsDir = path.join(dataDir, 'runs');
    fs.mkdirSync(this.templatesDir, { recursive: true });
    fs.mkdirSync(this.runsDir, { recursive: true });
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
