import { HerdrClient } from './herdr/client.js';
import { RealHerdrOps } from './orchestrate/herdr-ops.js';
import { Engine } from './orchestrate/engine.js';
import { Store } from './orchestrate/store.js';
import { buildHttpServer } from './api/http.js';
import { detectInstalledAgents, recommendAgentKind } from './api/env-check.js';
import { syncPiGatewayProvider } from './api/gateway.js';
import { DISPATCH_AGENT_KIND } from './api/dispatch.js';
import { loadConfig } from './config.js';
import { seedBuiltinTemplates } from './orchestrate/builtin-templates.js';
import { acquireInstanceLock, annotateInstanceLock, InstanceLockError, installProcessSurvival } from './lifecycle.js';

async function main(): Promise<void> {
  const config = loadConfig();
  // v13-S6 单实例守卫：同 dataDir 第二实例拒起——双实例互踩账本，
  // 且旧行为下第二实例在构造期就把在飞单一律改判 failed 写盘（发行包误敲即触发）
  let lock;
  try {
    lock = acquireInstanceLock(config.dataDir);
  } catch (err) {
    if (err instanceof InstanceLockError) {
      console.error(`[paneflow] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const client = new HerdrClient({ socketPath: config.herdrSocketPath });
  const ops = new RealHerdrOps(client);
  const store = new Store(config.dataDir);
  const seeded = seedBuiltinTemplates(
    (id) => store.getGraph(id),
    (g) => store.saveGraph(g),
  );
  if (seeded.length) console.log(`[paneflow] 内置场景模板已就绪：${seeded.length} 个`);
  const engine = new Engine(ops, store, {
    workspaceLabelPrefix: config.workspaceLabelPrefix,
    reconcileIntervalMs: config.reconcileIntervalMs,
    defaultNodeTimeoutMs: 30 * 60_000, // 免费网关模型慢，30min
    agentStartTimeoutMs: 240_000,
    agentReadyTimeoutMs: 360_000,
    paneEnv: config.paneEnv,
    maxConcurrentPanes: config.maxConcurrentPanes,
    promptConfirmWindowMs: config.promptConfirmWindowMs,
  });

  const { app } = await buildHttpServer({
    engine,
    store,
    ops,
    herdrSocketPath: config.herdrSocketPath,
    dataDir: config.dataDir,
    authToken: config.authToken,
    corsOrigins: config.corsOrigins,
  });

  await app.listen({ port: config.port, host: config.host });
  annotateInstanceLock(lock, config.port);
  // v13-S6 进程级兜底：拒绝无声死亡——未捕获异常落日志，信号到来走「掐 agent→关 workspace→flush 账本」；
  // 服务化（systemd/pm2/launchd）是操作系统的事，本文件不造 daemon 壳
  installProcessSurvival({
    onSignal: async (signal) => {
      try {
        await engine.shutdown(`收到 ${signal}`);
        await app.close();
      } finally {
        lock.release();
        process.exit(0);
      }
    },
    exitNow: (code) => {
      try {
        lock.release();
      } catch {
        /* 尽力而为 */
      }
      process.exit(code);
    },
  });
  console.log(`[paneflow] server listening on http://${config.host}:${config.port}`);
  console.log('[paneflow] 一键模式：浏览器打开上述地址即是画布（前端由服务端托管）');
  if (config.authToken) {
    console.log(`[paneflow] 访问令牌（仅此一次展示，浏览器首次访问时填入）: ${config.authToken}`);
  }
  console.log(`[paneflow] herdr socket: ${config.herdrSocketPath}`);
  console.log(`[paneflow] data dir: ${config.dataDir}`);
  // AF：网关启用时把 paneflow-gw provider 同步进 ~/.pi/agent/models.json（幂等合并写）
  try {
    const r = syncPiGatewayProvider(config.dataDir);
    if (r.synced) console.log(`[paneflow] pi 网关 provider 已${r.removed ? '移除' : '同步'}：${r.path}`);
  } catch {
    /* pi 未安装或不可写：忽略 */
  }
  // E'+AE：Planner agent 已可配置（空间档案 defaultAgentKind），缺省走自动推荐——启动时按实际会用的类型提示缺失
  const plannerKind =
    store.readProfile().defaultAgentKind || (await recommendAgentKind()) || DISPATCH_AGENT_KIND;
  void detectInstalledAgents([plannerKind]).then((installed) => {
    if (!installed.includes(plannerKind)) {
      console.warn(`[paneflow] 警告：智能下发依赖的 agent「${plannerKind}」未检测到，下发任务可能起不来`);
    }
  });

  // orphan sweep after boot (give herdr a moment if it is still starting)
  setTimeout(() => {
    void engine.recoverOrphans().then((reclaimed) => {
      if (reclaimed.length) {
        console.log(`[paneflow] reclaimed ${reclaimed.length} orphan workspace(s): ${reclaimed.join(', ')}`);
      }
    });
  }, 2000);
}

main().catch((err) => {
  console.error('[paneflow] fatal:', err);
  process.exit(1);
});
