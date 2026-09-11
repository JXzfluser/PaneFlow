import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DagGraph } from '@paneflow/shared';
import { GithubSync } from './github-sync.js';
import { Store } from '../orchestrate/store.js';

const CFG = { repo: 'owner/repo', token: 't', branch: 'main', dir: 'templates' };

type FetchLike = ConstructorParameters<typeof GithubSync>[2];

function graph(name: string): DagGraph {
  return {
    version: 1,
    name,
    nodes: [{ id: 'start', type: 'start', label: '开始', config: {} }],
    edges: [],
    metadata: { createdAt: '', updatedAt: '' },
  };
}

function makeFetch(handler: (url: string, method: string, body: unknown) => { status: number; json: unknown }): FetchLike {
  return (async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body) as unknown) : undefined;
    const r = handler(url, method, body);
    return {
      ok: r.status < 400,
      status: r.status,
      json: async () => r.json,
      text: async () => JSON.stringify(r.json),
    };
  }) as unknown as FetchLike;
}

describe('GithubSync', () => {
  let store: Store;

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-sync-'));
    store = new Store(dir);
    store.saveGraph(graph('alpha'));
    store.saveGraph(graph('beta'));
  });

  it('pushes every local template as a contents PUT on the configured branch', async () => {
    const reqs: { url: string; method: string; body: Record<string, unknown> }[] = [];
    const impl = makeFetch((url, method, body) => {
      reqs.push({ url, method, body: body as Record<string, unknown> });
      return { status: 200, json: {} };
    });
    const r = await new GithubSync(CFG, store, impl).pushAll();
    expect(r.pushed).toEqual(['alpha.json', 'beta.json']);
    expect(r.failed).toEqual([]);
    // listDir (GET) + one PUT per template
    expect(reqs).toHaveLength(3);
    const puts = reqs.filter((q) => q.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts[0]!.url).toBe('https://api.github.com/repos/owner/repo/contents/templates/alpha.json');
    expect(puts[0]!.body!.branch).toBe('main');
    expect(String(puts[0]!.body!.message)).toContain('alpha');
  });

  it('pulls templates from the repo into the local store', async () => {
    const b64 = Buffer.from(JSON.stringify(graph('from-cloud'))).toString('base64');
    const impl = makeFetch((url) => {
      if (url.includes('/contents/templates?ref=')) {
        return { status: 200, json: [{ name: 'from-cloud.json', path: 'templates/from-cloud.json', sha: 'x', type: 'file' }] };
      }
      return { status: 200, json: { content: b64, encoding: 'base64' } };
    });
    const r = await new GithubSync(CFG, store, impl).pullAll();
    expect(r.imported).toEqual(['from-cloud.json']);
    expect(store.getGraph('from-cloud')?.name).toBe('from-cloud');
  });

  it('treats a missing remote dir as empty on push and still uploads', async () => {
    const impl = makeFetch((url) => {
      if (url.includes('/contents/templates?ref=')) return { status: 404, json: {} };
      return { status: 200, json: {} };
    });
    const r = await new GithubSync(CFG, store, impl).pushAll();
    expect(r.pushed).toHaveLength(2);
    expect(r.failed).toEqual([]);
  });

  it('reports per-file failures without aborting the rest', async () => {
    const impl2 = makeFetch((url, method, body) => {
      if (method === 'GET') return { status: 404, json: {} };
      const msg = String((body as { message?: string }).message ?? '');
      return msg.includes('alpha') ? { status: 422, json: {} } : { status: 200, json: {} };
    });
    const r = await new GithubSync(CFG, store, impl2).pushAll();
    expect(r.pushed).toEqual(['beta.json']);
    expect(r.failed).toEqual([{ file: 'alpha.json', error: expect.stringContaining('422') }]);
  });
});
