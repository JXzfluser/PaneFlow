import { HerdrClient } from './herdr/client.js';
import { RealHerdrOps } from './orchestrate/herdr-ops.js';
import { Engine } from './orchestrate/engine.js';
import { Store } from './orchestrate/store.js';
import { buildHttpServer } from './api/http.js';
import { loadConfig } from './config.js';
import { seedBuiltinTemplates } from './orchestrate/builtin-templates.js';

async function main(): Promise<void> {
  const config = loadConfig();
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
  });

  const { app } = await buildHttpServer({
    engine,
    store,
    ops,
    herdrSocketPath: config.herdrSocketPath,
    dataDir: config.dataDir,
  });

  await app.listen({ port: config.port, host: '127.0.0.1' });
  console.log(`[paneflow] server listening on http://127.0.0.1:${config.port}`);
  console.log(`[paneflow] herdr socket: ${config.herdrSocketPath}`);
  console.log(`[paneflow] data dir: ${config.dataDir}`);

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
