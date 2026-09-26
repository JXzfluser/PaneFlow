import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildHttpServer } from './http.js';
import { judgeEnvProbe, probeEnvironment, type GitRead, type ProbeScene } from './env-probe.js';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';

/**
 * v14-E1 环境发现器（纯只读）。两层测试各管一段（照 env-check.ts 的 `probeWin32Binary` 先例）：
 *  - 判据层：喂**注入的假现场视图**锁三态（git 不可用 / 非 git 仓 / 多 lockfile 并存…），
 *    这些态在真机上不可靠复现，只能靠注入；
 *  - 真路层：`buildHttpServer` + `app.inject` 打 `POST /api/env/probe`，现场用 mkdtemp + 真 git
 *    造（**绝不用 stub 自造 payload**——那是 v0.1 期 K1 的假绿灯，v14 §六 已点名）。
 */

// -- 假现场视图 -------------------------------------------------------------

/**
 * 虚拟现场：`files` 键是绝对路径，值是文件内容（目录不存在时按「读不到」处理）；
 * `dirs` 显式声明的目录（哪怕里面一个文件都没有也要存在，skills/ 空目录是三态之一）；
 * `git` 按命令串（不含 `git` 与 `-C dir`）给读数：串 = ok 输出，GitRead = 原样三态。
 */
function fakeScene(o: {
  files?: Record<string, string>;
  dirs?: string[];
  git?: Record<string, string | GitRead>;
}): ProbeScene {
  const files = o.files ?? {};
  const dirs = new Set(o.dirs ?? []);
  const isDir = (p: string) => dirs.has(p);
  return {
    readDir(dir) {
      if (!isDir(dir)) return { error: '目录不存在' };
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const names = new Set<string>();
      for (const key of [...Object.keys(files), ...dirs]) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (!rest) continue;
        names.add(rest.split('/')[0]!);
      }
      return {
        entries: [...names]
          .sort()
          .map((name) => ({ name, isDirectory: isDir(path.join(dir, name)) })),
      };
    },
    fileSize(file) {
      const c = files[file];
      return isDir(file) || c === undefined ? null : Buffer.byteLength(c);
    },
    readText(file) {
      return files[file] ?? null;
    },
    git(_dir, args) {
      const v = (o.git ?? {})[args.join(' ')];
      if (v === undefined) return { ok: false, cause: 'failed', reason: 'git 未认（非零退出或无输出）' };
      return typeof v === 'string' ? { ok: true, out: v } : v;
    },
  };
}

const NO_GIT: GitRead = { ok: false, cause: 'no-git', reason: '本机 PATH 上没有 git 可执行' };
/** 富现场：仓根 /repo，七类全命中（worktree 两条） */
function richScene(): ProbeScene {
  return fakeScene({
    dirs: ['/repo', '/repo/skills', '/repo/docs', '/repo/.github/workflows', '/repo/.paneflow/skills'],
    files: {
      '/repo/AGENTS.md': '# 家规\n'.repeat(3),
      '/repo/README.md': '# 读我',
      '/repo/docs/style.md': '# 风格',
      '/repo/skills/export.md': '# 导出做法',
      '/repo/.paneflow/skills/ship.md': '# 发布做法',
      '/repo/package.json': JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' } }),
      '/repo/pnpm-lock.yaml': 'lockv: 9',
      '/repo/.github/workflows/ci.yml': 'on: push',
      '/repo/.git/config': '[remote "origin"]\n\turl = …',
    },
    git: {
      'rev-parse --show-toplevel': '/repo\n',
      'remote get-url origin': 'git@github.com:acme/app.git\n',
      'worktree list --porcelain': 'worktree /repo\nHEAD abc\n\nworktree /tmp/wt-one\nHEAD def\n',
    },
  });
}

const KINDS = ['repo', 'doc', 'skill', 'rule', 'check', 'workflow', 'worktree'] as const;

describe('judgeEnvProbe：七类判据与依据（注入现场）', () => {
  it('富现场逐类命中，且每一项都带非空依据（没依据的发现不入册）', () => {
    const r = judgeEnvProbe('/repo', richScene());
    expect(r.root).toBe('/repo');
    expect(r.error).toBeUndefined();
    const byKind = (k: (typeof KINDS)[number]) => r.items.filter((i) => i.kind === k);
    expect(byKind('repo').map((i) => i.name)).toEqual(['acme/app']);
    expect(byKind('repo')[0]!.detail).toContain('git@github.com:acme/app.git');
    expect(byKind('doc').map((i) => i.name)).toEqual(['AGENTS.md']);
    // 两个技能目录都吃，按相对路径排序
    expect(byKind('skill').map((i) => i.evidence)).toEqual(['.paneflow/skills/ship.md', 'skills/export.md']);
    expect(byKind('rule').map((i) => i.evidence)).toEqual(['README.md', 'docs/style.md']);
    expect(byKind('check').map((i) => i.name)).toEqual(['pnpm test', 'pnpm typecheck']);
    expect(byKind('workflow').map((i) => i.evidence)).toEqual(['.github/workflows/ci.yml']);
    // 只有「额外」worktree 入册（本仓那条不算）
    expect(byKind('worktree').map((i) => i.detail)).toEqual(['额外 worktree：/tmp/wt-one']);
    expect(r.items.length).toBeGreaterThan(0);
    for (const i of r.items) {
      expect(KINDS).toContain(i.kind);
      expect(i.evidence.length, `${i.kind}/${i.name} 缺依据`).toBeGreaterThan(0);
      expect(i.detail.length).toBeGreaterThan(0);
    }
    // 顺序=类目序（渲染稳定）
    expect(r.items.map((i) => i.kind)).toEqual([...r.items.map((i) => i.kind)].sort((a, b) => KINDS.indexOf(a) - KINDS.indexOf(b)));
    expect(r.missing).toEqual([]);
    expect(r.summary).toContain('git 仓 origin=acme/app');
    expect(r.summary).toContain('机检候选 pnpm test、pnpm typecheck');
  });

  it('只报存在与大小：约定文档/技能/规则项的 detail 里绝不出现被探文件的内容', () => {
    const r = judgeEnvProbe('/repo', richScene());
    for (const i of r.items.filter((x) => ['doc', 'skill', 'rule'].includes(x.kind))) {
      expect(i.detail).toMatch(/字节/);
      expect(i.detail).not.toContain('家规');
      expect(i.detail).not.toContain('导出做法');
    }
  });

  it('git 不可用（ENOENT）：不炸，repo/worktree 两类缺席并落到 missing，其余类目照常探', () => {
    const scene = fakeScene({
      files: {
        '/repo/AGENTS.md': 'x',
        '/repo/package.json': JSON.stringify({ scripts: { test: 'vitest' } }),
      },
      dirs: ['/repo'],
      // 唯一那条 git 查询就撞在「本机没有 git」上：三态必须与「有 git 但不认这个目录」分得开
      git: { 'rev-parse --show-toplevel': NO_GIT },
    });
    const r = judgeEnvProbe('/repo', scene);
    expect(r.root).toBeUndefined();
    expect(r.items.map((i) => i.kind)).not.toContain('repo');
    expect(r.items.map((i) => i.kind)).not.toContain('worktree');
    expect(r.missing.some((m) => m.includes('PATH 上没有 git'))).toBe(true);
    // 与「不是 git 仓」严格分家：后者是读数，前者是没现场可探
    expect(r.missing.some((m) => m.includes('不是 git 仓'))).toBe(false);
    // 非 git 目录照样吃文件类判据（base 回落到传入目录）；这份现场没 lockfile → 命令按 npm 形态给
    expect(r.items.map((i) => `${i.kind}:${i.name}`)).toEqual(['doc:AGENTS.md', 'check:npm test']);
    expect(r.summary).toContain('机检候选 npm test');
  });

  it('有 git 但不是仓：missing 说「不是 git 仓」，不提 PATH', () => {
    const r = judgeEnvProbe('/plain', fakeScene({ dirs: ['/plain'], files: {}, git: {} }));
    expect(r.root).toBeUndefined();
    expect(r.missing.some((m) => m.includes('不是 git 仓'))).toBe(true);
    expect(r.missing.some((m) => m.includes('PATH'))).toBe(false);
  });

  it('从子目录起探：探的是 rev-parse 认出的仓根（约定文档的家规位置），root 原样回显', () => {
    const scene = fakeScene({
      dirs: ['/repo/packages/app', '/repo'],
      files: { '/repo/AGENTS.md': 'x', '/repo/packages/app/package.json': '{}' },
      git: { 'rev-parse --show-toplevel': '/repo\n' },
    });
    const r = judgeEnvProbe('/repo/packages/app', scene);
    expect(r.root).toBe('/repo');
    expect(r.items.find((i) => i.kind === 'doc')?.evidence).toBe('AGENTS.md');
  });

  it('多套 lockfile 并存：另起一条披露项（真读数不是错误），命令按 pnpm>yarn>npm 取 pnpm', () => {
    const scene = fakeScene({
      dirs: ['/repo'],
      files: {
        '/repo/package.json': JSON.stringify({ scripts: { test: 'vitest' } }),
        '/repo/pnpm-lock.yaml': 'a',
        '/repo/yarn.lock': 'b',
        '/repo/package-lock.json': 'c',
      },
    });
    const r = judgeEnvProbe('/repo', scene);
    const disclose = r.items.filter((i) => i.kind === 'check' && i.name === '多套 lockfile 并存');
    expect(disclose).toHaveLength(1);
    expect(disclose[0]!.detail).toContain('pnpm-lock.yaml、yarn.lock、package-lock.json');
    expect(disclose[0]!.detail).toContain('取 pnpm');
    expect(disclose[0]!.evidence).toContain('yarn.lock');
    expect(r.items.find((i) => i.name === 'pnpm test')).toBeTruthy();
    // 没有 npm test 这种「另一种包管理器」的候选：口径唯一（一把锁只配一套命令）
    expect(r.items.filter((i) => i.kind === 'check' && i.name.endsWith(' test'))).toHaveLength(1);
  });

  it('没有 lockfile：机检候选仍给（scripts 是在册事实），但包管理器读数进 missing，命令注明按 npm 形态', () => {
    const scene = fakeScene({
      dirs: ['/repo'],
      files: { '/repo/package.json': JSON.stringify({ scripts: { test: 'vitest' } }) },
    });
    const r = judgeEnvProbe('/repo', scene);
    const c = r.items.find((i) => i.name === 'npm test')!;
    expect(c.detail).toContain('未探到 lockfile');
    expect(r.missing.some((m) => m.includes('没有 lockfile'))).toBe(true);
  });

  it('非 node 项目：探不到 package.json 就不硬造机检候选', () => {
    const scene = fakeScene({ dirs: ['/repo'], files: { '/repo/Makefile': 'all:' } });
    const r = judgeEnvProbe('/repo', scene);
    expect(r.items.some((i) => i.kind === 'check')).toBe(false);
    expect(r.missing.some((m) => m.includes('没有 package.json'))).toBe(true);
  });

  it('package.json 破烂 / scripts 里没有 test/typecheck → 各落一句，不猜命令', () => {
    const broken = judgeEnvProbe(
      '/repo',
      fakeScene({ dirs: ['/repo'], files: { '/repo/package.json': '{不是 JSON' } }),
    );
    expect(broken.items.some((i) => i.kind === 'check')).toBe(false);
    expect(broken.missing.some((m) => m.includes('读不出 scripts'))).toBe(true);
    const noScripts = judgeEnvProbe(
      '/repo',
      fakeScene({ dirs: ['/repo'], files: { '/repo/package.json': JSON.stringify({ scripts: { lint: 'eslint' } }) } }),
    );
    expect(noScripts.missing.some((m) => m.includes('机检候选零'))).toBe(true);
  });

  it('规则候选超上限：逐篇只列 20 条，其余以计数项入册（计数是总数，不是 20）', () => {
    const files: Record<string, string> = { '/repo/AGENTS.md': 'x' };
    for (let i = 0; i < 25; i++) files[`/repo/docs/d${String(i).padStart(2, '0')}.md`] = 'x';
    const r = judgeEnvProbe('/repo', fakeScene({ dirs: ['/repo', '/repo/docs'], files }));
    const rules = r.items.filter((i) => i.kind === 'rule');
    expect(rules.filter((i) => i.evidence.endsWith('.md'))).toHaveLength(20);
    const countItem = rules.at(-1)!;
    expect(countItem.detail).toContain('共 25 篇');
    expect(countItem.evidence.startsWith('<')).toBe(true);
    expect(r.summary).toContain('规则候选 25 篇');
    // 约定文档不算规则候选（已以 doc 类目入册，不重复计）
    expect(rules.some((i) => i.evidence === 'AGENTS.md')).toBe(false);
  });

  it('worktree 只有本仓一条：不写空项占位（没有就是没有）', () => {
    const scene = fakeScene({
      dirs: ['/repo'],
      files: { '/repo/AGENTS.md': 'x' },
      git: { 'rev-parse --show-toplevel': '/repo\n', 'worktree list --porcelain': 'worktree /repo\nHEAD abc\n' },
    });
    const r = judgeEnvProbe('/repo', scene);
    expect(r.items.some((i) => i.kind === 'worktree')).toBe(false);
  });

  it('skills 目录存在但第一层无 md：缺项文案说清口径，不冒充「没有 skills 目录」', () => {
    const empty = judgeEnvProbe('/repo', fakeScene({ dirs: ['/repo', '/repo/skills'], files: {} }));
    expect(empty.missing.some((m) => m.includes('第一层没有 *.md'))).toBe(true);
    const none = judgeEnvProbe('/repo', fakeScene({ dirs: ['/repo'], files: {} }));
    expect(none.missing.some((m) => m.includes('没有 skills 目录'))).toBe(true);
  });

  it('现场读不到：一句人话读数 + items 全空，missing 留空（没读到现场就不逐类目说「没有」）', () => {
    const r = judgeEnvProbe('/nope', fakeScene({ dirs: [], files: {} }));
    expect(r.error).toContain('这个目录读不到：目录不存在（/nope）');
    expect(r.items).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(r.summary).toBeUndefined();
    expect(r.root).toBeUndefined();
  });

  it('ssh:// 与 https:// 远端都能归一 owner/repo；非 GitHub 形态不归一并如实说明', () => {
    const nameOf = (url: string) =>
      judgeEnvProbe(
        '/repo',
        fakeScene({ dirs: ['/repo'], git: { 'rev-parse --show-toplevel': '/repo', 'remote get-url origin': url } }),
      ).items.find((i) => i.kind === 'repo');
    expect(nameOf('ssh://git@github.com/o/r.git')?.name).toBe('o/r');
    expect(nameOf('https://github.com/o/r.git')?.name).toBe('o/r');
    const other = nameOf('git@git.internal:team/tool.git')!;
    expect(other.name).toBe('git@git.internal:team/tool.git');
    expect(other.detail).toContain('未归一出 owner/repo');
  });

  it('git 仓没有 origin：repo 项缺席并落一句缺项（不是拿 URL 空串占位）', () => {
    const r = judgeEnvProbe(
      '/repo',
      fakeScene({ dirs: ['/repo'], git: { 'rev-parse --show-toplevel': '/repo' } }),
    );
    expect(r.items.some((i) => i.kind === 'repo')).toBe(false);
    expect(r.root).toBe('/repo');
    expect(r.missing.some((m) => m.includes('没有 origin 远端'))).toBe(true);
  });

  it('probeEnvironment：注入现场与 agent 探测器，agentsAvailable 是 server 给的读数', async () => {
    const r = await probeEnvironment('/repo', { scene: richScene(), detectAgents: async () => ['pi', 'opencode'] });
    expect(r.agentsAvailable).toEqual(['pi', 'opencode']);
    expect(r.root).toBe('/repo');
    const empty = await probeEnvironment('/nope', { scene: fakeScene({}), detectAgents: async () => [] });
    expect(empty.error).toContain('读不到');
    // [] 是正读数（本机一个 agent CLI 都没探到），与「缺键」分家——这里必须落键
    expect(empty.agentsAvailable).toEqual([]);
  });
});

// -- 真路：POST /api/env/probe ----------------------------------------------

function buildServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-envprobe-'));
  return buildHttpServer({
    engine: { onChange: () => {} } as unknown as Engine,
    store: {} as unknown as Store,
    ops: {} as unknown as HerdrOps,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
  });
}

const HOST = '127.0.0.1:4310';
const tmp = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-envprobe-repo-')));

/** 真造现场：git init + origin + 各类文件（探测本身只读，写盘只发生在这份临时夹具里） */
function makeRepo(extra: 'worktree' | 'plain' = 'plain'): string {
  const dir = tmp();
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:acme/app.git']);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# 家规\n'.repeat(4));
  fs.writeFileSync(path.join(dir, 'README.md'), '# 读我');
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'style.md'), '# 风格');
  fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'export.md'), '# 导出做法');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' } }));
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  fs.writeFileSync(path.join(dir, 'yarn.lock'), '# yarn');
  fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), 'on: push\n');
  if (extra === 'worktree') {
    // 真造一个 linked worktree：porcelain 的输出形状只能在有提交后有第二个 worktree 时才存在
    execFileSync('git', [
      '-C',
      dir,
      '-c',
      'user.email=pf@test',
      '-c',
      'user.name=pf',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'seed',
    ]);
    execFileSync('git', ['-C', dir, 'worktree', 'add', '-q', '-b', 'wt-branch', path.join(path.dirname(dir), `${path.basename(dir)}-wt`)]);
  }
  return dir;
}

/** 真路响应的最小读法（形状=env-probe.ts 的 EnvProbeResult；这里重述一遍以免测试依赖实现细节） */
interface ProbeBody {
  path: string;
  root?: string;
  summary?: string;
  error?: string;
  items: { kind: string; name: string; detail: string; evidence: string }[];
  missing: string[];
  agentsAvailable?: string[];
}

async function post(app: FastifyInstance, payload?: Record<string, unknown>): Promise<{ statusCode: number; body: string; json: () => ProbeBody }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/env/probe',
    headers: { host: HOST },
    ...(payload === undefined ? {} : { payload }),
  });
  return res as unknown as { statusCode: number; body: string; json: () => ProbeBody };
}

describe('POST /api/env/probe（v14-E1 真路）', () => {
  it('真现场逐项发现：repo/doc/skill/rule/check/workflow 全命中，每项 evidence 非空', async () => {
    const dir = makeRepo();
    const { app } = await buildServer();
    try {
      const res = await post(app, { path: dir });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.path).toBe(dir);
      expect(body.root).toBe(dir);
      const pick = (kind: string) => body.items.filter((i) => i.kind === kind);
      expect(pick('repo').map((i) => i.name)).toEqual(['acme/app']);
      expect(pick('doc').map((i) => i.name)).toEqual(['AGENTS.md']);
      expect(pick('skill').map((i) => i.evidence)).toEqual(['skills/export.md']);
      expect(pick('rule').map((i) => i.evidence)).toEqual(['README.md', 'docs/style.md']);
      // 两套 lockfile 并存 → 先披露、再给 pnpm 形态的两枚机检候选
      expect(pick('check').map((i) => i.name)).toEqual([
        '多套 lockfile 并存',
        'pnpm test',
        'pnpm typecheck',
      ]);
      expect(pick('workflow').map((i) => i.name)).toEqual(['ci.yml']);
      for (const i of body.items) expect(i.evidence.length).toBeGreaterThan(0);
      expect(body.missing).toEqual([]);
      expect(body.summary).toContain('git 仓 origin=acme/app');
      expect(Array.isArray(body.agentsAvailable)).toBe(true);
      // 只报存在与大小：整份响应里绝不出现被探文档的正文
      expect(res.body).not.toContain('# 家规');
      expect(res.body).not.toContain('导出做法');
    } finally {
      await app.close();
    }
  });

  it('真 git worktree：第二条 worktree 入册并带路径，本仓那条不占位', async () => {
    const dir = makeRepo('worktree');
    const { app } = await buildServer();
    try {
      const body = (await post(app, { path: dir })).json();
      const wt = body.items.filter((i) => i.kind === 'worktree');
      expect(wt).toHaveLength(1);
      expect(wt[0]!.detail).toContain(`${path.basename(dir)}-wt`);
      expect(wt[0]!.evidence).toBe('.git/worktrees/');
      expect(body.missing).toEqual([]);
      expect(body.summary).toContain('额外 worktree 1 个');
    } finally {
      await app.close();
    }
  });

  it('探测失败是读数不是客户端错误：路径不存在 / 指向文件 → 200 带一句人话与空 items', async () => {
    const dir = makeRepo();
    const file = path.join(dir, 'AGENTS.md');
    const { app } = await buildServer();
    try {
      for (const p of [path.join(dir, 'nope-no-such'), file]) {
        const res = await post(app, { path: p });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.items).toEqual([]);
        expect(body.missing).toEqual([]);
        expect(body.error).toContain('这个目录读不到');
        expect(body.error).toContain(p);
        expect('root' in body).toBe(false);
      }
    } finally {
      await app.close();
    }
  });

  it('空目录：items 全缺但 missing 有话（逐类目说清没探到什么）', async () => {
    const dir = tmp();
    const { app } = await buildServer();
    try {
      const body = (await post(app, { path: dir })).json();
      expect(body.items).toEqual([]);
      expect(body.error).toBeUndefined();
      expect(body.missing.length).toBeGreaterThan(2);
      const text = body.missing.join('\n');
      for (const needle of ['skills', '约定文档', 'package.json', 'workflow']) {
        expect(text).toContain(needle);
      }
      expect(body.summary).toContain('未发现任何可登记项');
    } finally {
      await app.close();
    }
  });

  it('脏体才 400：缺 path / 非串 / 空串 / 相对路径（不猜基准），server 的一句指路落在 body.error', async () => {
    const { app } = await buildServer();
    try {
      for (const payload of [undefined, {}, { path: 42 }, { path: '   ' }]) {
        const res = await post(app, payload as Record<string, unknown> | undefined);
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect(res.json() as unknown as { error: string }).toMatchObject({ error: expect.stringContaining('path 必填') });
      }
      const rel = await post(app, { path: 'relative/dir' });
      expect(rel.statusCode).toBe(400);
      expect((rel.json() as unknown as { error: string }).error).toContain('必须是绝对路径');
    } finally {
      await app.close();
    }
  });
});
