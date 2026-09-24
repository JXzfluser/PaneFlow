#!/usr/bin/env node
// Z1 免克隆部署：把 monorepo 装配成一个自包含的 npm 包（server 打包为单文件 ESM + 托管 web 构建产物），
// 产出 out/release/paneflow-<ver>.tgz 与 paneflow-latest.tgz，供 GitHub Release / npm / install.sh 消费。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
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

// 2b) v11-A1：CLI 子命令打包为单文件（零 npm 依赖的 HTTP 薄壳，与 launcher 合流）
await build({
  entryPoints: [path.join(repoRoot, 'packages', 'cli', 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: path.join(pkgDir, 'lib', 'cli.mjs'),
});

// 3) 携带前端产物 → <pkg>/web
fs.cpSync(path.join(repoRoot, 'packages', 'web', 'dist'), path.join(pkgDir, 'web'), { recursive: true });

// 4) 图标（README/浏览器 favicon 同源）
const iconSrc = path.join(repoRoot, 'packages', 'web', 'public', 'icon.svg');
if (fs.existsSync(iconSrc)) fs.copyFileSync(iconSrc, path.join(pkgDir, 'web', 'icon.svg'));

// 5) bin：统一入口——**原样拷贝仓库根 bin/paneflow.mjs**，不在打包脚本里内联生成路由代码。
//    （曾经内联了一份子命令白名单，产物随 CLI 演进漂移：v0.2.0 装机版 replay/experiments 掉进
//    起服务分支。launcher 判据现在只认「无首参或 serve 才起服务」，拷贝即零漂移面。）
const launcherSrc = path.join(repoRoot, 'bin', 'paneflow.mjs');
if (!fs.existsSync(launcherSrc)) throw new Error(`缺少发行入口：${launcherSrc}`);
fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
fs.copyFileSync(launcherSrc, path.join(pkgDir, 'bin', 'paneflow.mjs'));
fs.chmodSync(path.join(pkgDir, 'bin', 'paneflow.mjs'), 0o755);

// 5b) 许可文本随产物走（实测 v0.2.0 包内无 LICENSE：npm 只打包 pkgDir 里存在的文件，
//     仓库根的 LICENSE 从不入包——v6 OSS 承诺的欠账正身）。license 字段以根清单为单一事实源。
if (!root.license) throw new Error('根 package.json 缺 license 字段（发行包许可面不完整）');
const licenseSrc = path.join(repoRoot, 'LICENSE');
if (!fs.existsSync(licenseSrc)) throw new Error(`缺少许可文本：${licenseSrc}`);
fs.copyFileSync(licenseSrc, path.join(pkgDir, 'LICENSE'));

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
      files: ['bin', 'lib', 'web', 'LICENSE'],
      engines: root.engines,
      license: root.license,
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

// 8) 校验和 sidecar：install.sh 下载后据此做 digest 校验（无 digest 的免克隆安装等于装任意字节）。
//    格式照 `shasum -a 256` 输出（<hex> 两空格 <文件名>），便于人直接核。
for (const name of [`paneflow-${version}.tgz`, 'paneflow-latest.tgz']) {
  const buf = fs.readFileSync(path.join(outDir, name));
  const hex = createHash('sha256').update(buf).digest('hex');
  fs.writeFileSync(path.join(outDir, `${name}.sha256`), `${hex}  ${name}\n`);
}
console.log(
  `[build-release] 产出：\n  ${tgz}\n  ${path.join(outDir, 'paneflow-latest.tgz')}\n  ${path.join(outDir, 'paneflow-latest.tgz.sha256')}`,
);
