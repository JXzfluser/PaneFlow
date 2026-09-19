#!/usr/bin/env node
// Z1 免克隆部署：把 monorepo 装配成一个自包含的 npm 包（server 打包为单文件 ESM + 托管 web 构建产物），
// 产出 out/release/paneflow-<ver>.tgz 与 paneflow-latest.tgz，供 GitHub Release / npm / install.sh 消费。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(repoRoot, p), 'utf8'));

const root = readJson('package.json');
const serverPkg = readJson('packages/server/package.json');
const version = root.version;
const outDir = path.join(repoRoot, 'out', 'release');
const pkgDir = path.join(outDir, `paneflow-${version}`);

// 1) 前端构建（vite）——产物 packages/web/dist
execFileSync('pnpm', ['--filter', '@paneflow/web', 'build'], { cwd: repoRoot, stdio: 'inherit' });

// 2) 服务端 esbuild 单文件打包：workspace 依赖内联，npm 依赖保持 external
const bundleFile = path.join(pkgDir, 'lib', 'server.mjs');
fs.rmSync(pkgDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(bundleFile), { recursive: true });
await build({
  entryPoints: [path.join(repoRoot, 'packages', 'server', 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: bundleFile,
  external: ['fastify', '@fastify/cors', '@fastify/websocket', '@fastify/static'],
});

// 3) 携带前端产物 → <pkg>/web
fs.cpSync(path.join(repoRoot, 'packages', 'web', 'dist'), path.join(pkgDir, 'web'), { recursive: true });

// 4) 图标（README/浏览器 favicon 同源）
const iconSrc = path.join(repoRoot, 'packages', 'web', 'public', 'icon.svg');
if (fs.existsSync(iconSrc)) fs.copyFileSync(iconSrc, path.join(pkgDir, 'web', 'icon.svg'));

// 5) bin：设 PF_WEB_DIR 后启动内联服务
fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
fs.writeFileSync(
  path.join(pkgDir, 'bin', 'paneflow.mjs'),
  [
    '#!/usr/bin/env node',
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "const dir = path.dirname(fileURLToPath(import.meta.url));",
    "process.env.PF_WEB_DIR ??= path.join(dir, '..', 'web');",
    "await import('../lib/server.mjs');",
    '',
  ].join('\n'),
  { mode: 0o755 },
);

// 6) 发布包 package.json：运行时只依赖 4 个 npm 包（版本从源清单继承）
const deps = {
  fastify: serverPkg.dependencies.fastify,
  '@fastify/cors': serverPkg.dependencies['@fastify/cors'],
  '@fastify/websocket': serverPkg.dependencies['@fastify/websocket'],
  '@fastify/static': root.dependencies['@fastify/static'],
};
fs.writeFileSync(
  path.join(pkgDir, 'package.json'),
  JSON.stringify(
    {
      name: 'paneflow',
      version,
      description: `${root.description}（免源码发行包：服务端 + 托管画布）`,
      type: 'module',
      bin: { paneflow: 'bin/paneflow.mjs' },
      files: ['bin', 'lib', 'web'],
      engines: root.engines,
      license: 'MIT',
      repository: { type: 'git', url: 'git+https://github.com/JXzfluser/PaneFlow.git' },
      dependencies: deps,
    },
    null,
    2,
  ) + '\n',
);

// 7) npm pack 出标准 tgz（npm i -g <file|url> 直接可装）
execFileSync('npm', ['pack', '--pack-destination', outDir], { cwd: pkgDir, stdio: 'inherit' });
const tgz = path.join(outDir, `paneflow-${version}.tgz`);
fs.copyFileSync(tgz, path.join(outDir, 'paneflow-latest.tgz'));
console.log(`[build-release] 产出：\n  ${tgz}\n  ${path.join(outDir, 'paneflow-latest.tgz')}`);
