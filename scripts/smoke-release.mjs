#!/usr/bin/env node
// v13-E1 发行链冒烟：对 build-release 的真产物下断言，专治「非零即绿」假验——
// 每条用例同时钉死 **精确退出码** 与 **输出内容子串**，任一不符即整体退 1。
// 覆盖三件事：① launcher 与仓库根 bin/paneflow.mjs 字节一致（发行面不存第二份路由清单）；
// ② CLI 分支（--help / 未知子命令 / 连不上时的失败路）；③ server 分支（裸参、serve 别名真起服务，
// 起来后薄壳命令真打得通）。隔离在一次性 dataDir/HOME，绝不碰 ~/.paneflow，且只杀本脚本自起的 PID。
// 用法：node scripts/build-release.mjs && node scripts/smoke-release.mjs
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
const pkgDir = path.join(repoRoot, 'out', 'release', `paneflow-${version}`);
const launcher = path.join(pkgDir, 'bin', 'paneflow.mjs');
const outDir = path.join(repoRoot, 'out', 'release');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
}

/** 跑一次产物入口，拿 {code, stdout, stderr}（不抛异常——退出码本身就是被断言的对象） */
function runCli(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [launcher, ...args], {
      encoding: 'utf8',
      cwd: pkgDir,
      timeout: 60_000,
      env: { ...process.env, NO_COLOR: '1', ...env },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err;
    return { code: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** 断言：精确退出码 + stdout/stderr 必含子串 */
function expectRun(name, res, { code, out = [], err = [] }) {
  const problems = [];
  if (res.code !== code) problems.push(`退出码期望 ${code}、实得 ${res.code}`);
  for (const s of out) if (!res.stdout.includes(s)) problems.push(`stdout 缺子串「${s}」`);
  for (const s of err) if (!res.stderr.includes(s)) problems.push(`stderr 缺子串「${s}」`);
  check(name, problems.length === 0, problems.join('；') || `code=${res.code}`);
}

/** 断言：这条命令**没有**起服务（起服务分支的三句开机日志一句都不许出现），且自己退了 */
function expectNoServe(name, res) {
  const all = `${res.stdout}\n${res.stderr}`;
  const markers = ['server listening', '内置场景模板已就绪', '一键模式'];
  const hit = markers.filter((m) => all.includes(m));
  check(
    name,
    hit.length === 0 && (res.code === 0 || res.code === 1),
    `code=${res.code}${hit.length ? `、出现起服务日志：${hit.join('/')}` : ''}`,
  );
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function healthOk(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return false;
    await res.json();
    return true;
  } catch {
    return false;
  }
}

/** 起产物 server（隔离 dataDir/HOME + 不存在 socket），轮询 health；返回 {pid, port, log} */
async function startPackagedServer(tmpHome, args = []) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paneflow-smoke-data-'));
  const port = await freePort();
  const child = spawn(process.execPath, [launcher, ...args], {
    cwd: pkgDir,
    env: {
      ...process.env,
      NO_COLOR: '1',
      HOME: tmpHome,
      PF_PORT: String(port),
      PF_DATA_DIR: dataDir,
      PF_HERDR_SOCKET: path.join(dataDir, 'no-herdr.sock'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (b) => (log += b.toString()));
  child.stderr.on('data', (b) => (log += b.toString()));
  child.on('exit', (code) => (log += `\n[exit ${code}]\n`));
  let up = false;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) break;
    if (await healthOk(port)) {
      up = true;
      break;
    }
    await sleep(500);
  }
  return { child, port, dataDir, up, getLog: () => log };
}

/** 只收本脚本自己起的那个 PID；等它真退出，不留孤儿 */
async function stopPackagedServer(handle) {
  if (!handle || handle.child.exitCode !== null) return;
  handle.child.kill('SIGTERM');
  for (let i = 0; i < 40; i++) {
    if (handle.child.exitCode !== null) return;
    await sleep(250);
  }
  handle.child.kill('SIGKILL');
}

async function main() {
  if (!fs.existsSync(launcher)) {
    console.error(`产物缺失：${launcher}（先跑 node scripts/build-release.mjs）`);
    process.exitCode = 1;
    return;
  }
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'paneflow-smoke-home-'));

  try {
    // ---- A. 发行面结构：launcher 就是仓库那份文件，产物里不存在第二份路由清单 ----
    const same =
      fs.readFileSync(launcher).equals(fs.readFileSync(path.join(repoRoot, 'bin', 'paneflow.mjs')));
    check('A1 产物 bin/paneflow.mjs 与仓库根 bin/paneflow.mjs 字节一致', same);
    const launcherSrc = fs.readFileSync(launcher, 'utf8');
    check(
      'A2 launcher 不含子命令白名单（判据反向：清单只活在 CLI 里）',
      !launcherSrc.includes('CLI_SUBCOMMANDS') && !/'dispatch'/.test(launcherSrc),
    );

    // ---- B. 许可面：LICENSE 真进了 tgz，且 digest sidecar 与包体一致 ----
    check('B1 pkgDir 内有 LICENSE', fs.existsSync(path.join(pkgDir, 'LICENSE')));
    const tgz = path.join(outDir, `paneflow-${version}.tgz`);
    if (fs.existsSync(tgz)) {
      const listing = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' });
      check('B2 tgz 内含 package/LICENSE', listing.split('\n').includes('package/LICENSE'), `tar -tzf 抽样：${listing.split('\n').slice(0, 6).join(' ')}`);
      const sidecarPath = `${tgz}.sha256`;
      if (fs.existsSync(sidecarPath)) {
        const expected = fs.readFileSync(sidecarPath, 'utf8').trim().split(/\s+/)[0];
        const actual = createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
        check('B3 tgz 的 sha256 与 sidecar 一致', expected === actual, `${expected} vs ${actual}`);
      } else {
        check('B3 tgz 的 sha256 与 sidecar 一致', false, `缺 ${path.basename(sidecarPath)}`);
      }
    } else {
      check('B2 tgz 内含 package/LICENSE', false, `未找到 ${tgz}`);
    }

    // ---- C. 运行期依赖：产物目录需能解析 fastify（CI 里 npm pack 不带 node_modules） ----
    if (!fs.existsSync(path.join(pkgDir, 'node_modules', 'fastify'))) {
      console.log('→ 产物目录缺 node_modules，执行 npm install --omit=dev');
      execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd: pkgDir,
        stdio: 'inherit',
      });
    }

    const deadUrl = `http://127.0.0.1:${await freePort()}`;
    const cliEnv = { HOME: tmpHome, PANEFLOW_URL: deadUrl };

    // ---- D. CLI 分支（旗标首参绝不被当成「起服务」；未知子命令由 CLI 自己判） ----
    expectRun('D1 `--help` 走 CLI：出用法、退 0', runCli(['--help'], cliEnv), {
      code: 0,
      out: ['用法：paneflow <子命令>', 'paneflow experiments'],
    });
    expectRun('D2 `-h` 走 CLI：出用法、退 0', runCli(['-h'], cliEnv), { code: 0, out: ['用法：paneflow'] });
    expectRun(
      'D3 未知子命令不进起服务分支：CLI 报「未知子命令」、退 1',
      runCli(['totally-not-a-subcommand'], cliEnv),
      { code: 1, err: ['未知子命令：totally-not-a-subcommand', '用法：paneflow'] },
    );
    expectRun('D4 `runs` 连不上服务：失败路、退 1（不是 0 也不是无声）', runCli(['runs'], cliEnv), {
      code: 1,
      err: ['✘'],
    });
    // 旗标首参只要求「绝不落起服务分支」：现在 CLI 报未知子命令退 1，日后补了 --version 实现
    // 也照样绿——这条钉的是 launcher 的判据，不是 CLI 的待办。
    expectNoServe('D5 `--version` 首参不落起服务分支', runCli(['--version'], cliEnv));
    expectNoServe('D6 任意旗标首参（`--json`）不落起服务分支', runCli(['--json'], cliEnv));

    // ---- E. server 分支：只有「无首参」与「serve」两个入口，且真能用 ----
    const bare = await startPackagedServer(tmpHome);
    try {
      check('E1 裸 `paneflow`（无首参）起服务：/api/health 200', bare.up, bare.up ? `port=${bare.port}` : `日志尾：${bare.getLog().slice(-400)}`);
      if (bare.up) {
        const url = `http://127.0.0.1:${bare.port}`;
        expectRun('E2 新起服务上 `runs` 真打得通：出空清单文案、退 0', runCli(['runs'], { HOME: tmpHome, PANEFLOW_URL: url }), {
          code: 0,
          out: ['（暂无 run）'],
        });
        expectRun(
          'E3 新起服务上 `experiments --suite c4` 真打得通（v0.2.0 漂移就掉在这条路上）、退 0',
          runCli(['experiments', '--suite', 'c4'], { HOME: tmpHome, PANEFLOW_URL: url }),
          { code: 0, out: ['（暂无实验收数'] },
        );
      }
    } finally {
      await stopPackagedServer(bare);
    }
    check('E4 本脚本自起的裸参服务已收掉（不留孤儿）', bare.child.exitCode !== null);

    const served = await startPackagedServer(tmpHome, ['serve']);
    try {
      check('E5 显式 `paneflow serve` 起服务：/api/health 200', served.up, served.up ? `port=${served.port}` : `日志尾：${served.getLog().slice(-400)}`);
    } finally {
      await stopPackagedServer(served);
    }
    check('E6 本脚本自起的 serve 实例已收掉（不留孤儿）', served.child.exitCode !== null);
    fs.rmSync(bare.dataDir, { recursive: true, force: true });
    fs.rmSync(served.dataDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[smoke-release] ${results.length - failed.length}/${results.length} 通过`);
  process.exitCode = failed.length ? 1 : 0;
}

await main();
