import fs from 'node:fs';
import path from 'node:path';
import type { DagGraph } from '@paneflow/shared';
import type { Store } from '../orchestrate/store.js';

export interface GithubSyncConfig {
  /** owner/name, e.g. JXzfluser/PaneFlow */
  repo: string;
  /** fine-grained PAT with Contents read/write on the repo */
  token: string;
  /** branch (default main) */
  branch: string;
  /** directory inside the repo (default templates) */
  dir: string;
}

export interface FetchLike {
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }>;
}

export function loadSyncConfig(env: NodeJS.ProcessEnv = process.env): GithubSyncConfig | null {
  const repo = env.PF_GITHUB_REPO;
  const token = env.PF_GITHUB_TOKEN;
  if (!repo || !token || !repo.includes('/')) return null;
  return {
    repo,
    token,
    branch: env.PF_GITHUB_BRANCH ?? 'main',
    dir: env.PF_GITHUB_DIR ?? 'templates',
  };
}

const API = 'https://api.github.com';

function headers(cfg: GithubSyncConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${cfg.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

interface ContentsItem {
  name: string;
  path: string;
  sha: string | null;
  type: string;
  content?: string;
}

/**
 * Optional, switchable GitHub 沉淀: templates live under `<dir>/*.json`.
 * All operations are async and never block pipeline execution; the token
 * comes from env and is never logged or persisted.
 */
export class GithubSync {
  constructor(
    private readonly cfg: GithubSyncConfig,
    private readonly store: Store,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  /** Push every local template to the repo. Returns per-file results. */
  async pushAll(): Promise<{ pushed: string[]; failed: { file: string; error: string }[] }> {
    const graphs = this.store.listGraphs();
    const pushed: string[] = [];
    const failed: { file: string; error: string }[] = [];
    const existing = await this.listDir().catch(() => [] as ContentsItem[]);
    for (const g of graphs) {
      const file = `${g.name}.json`;
      const content = Buffer.from(JSON.stringify(g, null, 2)).toString('base64');
      const sha = existing.find((e) => e.name === file)?.sha ?? null;
      try {
        const res = await this.fetchImpl(
          `${API}/repos/${this.cfg.repo}/contents/${this.cfg.dir}/${file}`,
          {
            method: 'PUT',
            headers: headers(this.cfg),
            body: JSON.stringify({
              message: `PaneFlow 模板沉淀: ${g.name}`,
              content,
              branch: this.cfg.branch,
              ...(sha ? { sha } : {}),
            }),
          },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
        pushed.push(file);
      } catch (err) {
        failed.push({ file, error: (err as Error).message });
      }
    }
    return { pushed, failed };
  }

  /** Pull templates from the repo and merge them into the local store. */
  async pullAll(): Promise<{ imported: string[]; failed: { file: string; error: string }[] }> {
    const items = await this.listDir();
    const imported: string[] = [];
    const failed: { file: string; error: string }[] = [];
    for (const item of items) {
      if (item.type !== 'file' || !item.name.endsWith('.json')) continue;
      try {
        const res = await this.fetchImpl(
          `${API}/repos/${this.cfg.repo}/contents/${item.path}?ref=${this.cfg.branch}`,
          { headers: headers(this.cfg) },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { content?: string; encoding?: string };
        if (body.encoding !== 'base64' || !body.content) throw new Error('unexpected contents payload');
        const graph = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')) as DagGraph;
        if (graph?.version !== 1 || !Array.isArray(graph.nodes)) throw new Error('not a DagGraph');
        this.store.saveGraph(graph);
        imported.push(item.name);
      } catch (err) {
        failed.push({ file: item.name, error: (err as Error).message });
      }
    }
    return { imported, failed };
  }

  private async listDir(): Promise<ContentsItem[]> {
    const res = await this.fetchImpl(
      `${API}/repos/${this.cfg.repo}/contents/${this.cfg.dir}?ref=${this.cfg.branch}`,
      { headers: headers(this.cfg) },
    );
    if (res.status === 404) return []; // dir not created yet
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const body = (await res.json()) as ContentsItem[];
    return Array.isArray(body) ? body : [];
  }
}

/** Re-exported for the HTTP layer: describe why sync is unavailable. */
export function syncUnavailableReason(env: NodeJS.ProcessEnv = process.env): string {
  if (!env.PF_GITHUB_REPO && !env.PF_GITHUB_TOKEN) return '未配置 PF_GITHUB_REPO / PF_GITHUB_TOKEN';
  if (!env.PF_GITHUB_REPO) return '缺少 PF_GITHUB_REPO（owner/name）';
  return '缺少 PF_GITHUB_TOKEN';
}
