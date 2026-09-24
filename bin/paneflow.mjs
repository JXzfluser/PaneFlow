#!/usr/bin/env node
// PaneFlow 发行入口（npm 全局 `paneflow` 命令指向此文件；本文件被 build-release 原样拷进产物）。
//
// v13-E1 窄判据（反向）：**只有「无首参」或首参恰为 `serve` 才起 server，其余一律进 CLI 薄壳**。
// 为什么不在这列「哪些算子命令」：任何清单都会随 CLI 演进漂移——实锤是 v0.2.0 装机版上
// `replay`/`experiments` 掉进起服务分支（AGENTS.md 说明书命令打不通），而误起的第二实例会在
// server 构造期就把在飞单改判 failed 写盘。清单的单一事实源只能是 CLI 自己（未知子命令由
// `main()` 报「未知子命令」并退 1），这里因此永不落后于 CLI。
// 顺带结同类雷：`--help`/`-h`/`--version` 这类旗标首参按本判据也走 CLI，绝不会被当成「起服务」。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const first = process.argv[2];

if (first === undefined || first === 'serve') {
  process.env.PF_WEB_DIR ??= path.join(dir, '..', 'web');
  await import('../lib/server.mjs');
} else {
  const { main, defaultIo } = await import('../lib/cli.mjs');
  process.exitCode = await main(process.argv.slice(2), defaultIo());
}
