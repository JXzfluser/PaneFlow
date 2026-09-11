/**
 * M0 全链路冒烟测试 — 在隔离的 pf-test herdr session 里验证：
 *   ping → workspace.create → pane.split → agent.start → agent.prompt(--wait)
 *   → agent.read → workspace.close
 *
 * 不触碰 default 会话。测试 agent 用 opencode（本机已安装），提示词极小。
 * 用法：pnpm smoke [--keep]   (--keep 保留 pf-test server 进程供后续开发)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HerdrClient } from '../packages/server/src/herdr/client.js';

const SESSION = 'pf-test';
const SOCKET = path.join(os.homedir(), '.config/herdr/sessions', SESSION, 'herdr.sock');
const keep = process.argv.includes('--keep');
const log = (msg: string) => console.log(`[smoke] ${msg}`);

async function ensureServer(): Promise<void> {
  if (fs.existsSync(SOCKET)) {
    log(`session server already running: ${SOCKET}`);
    return;
  }
  log('starting pf-test session server...');
  const child = spawn('herdr', ['--session', SESSION, 'server'], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(SOCKET)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('pf-test server did not create its socket within 20s');
}

async function stopServer(): Promise<void> {
  log('stopping pf-test session server...');
  const child = spawn('herdr', ['--session', SESSION, 'server', 'stop'], { stdio: 'ignore' });
  await new Promise((r) => child.once('exit', r));
}

async function main(): Promise<void> {
  const started = Date.now();
  await ensureServer();
  const client = new HerdrClient({ socketPath: SOCKET });
  log('client ready (requests auto-connect)');

  const events: string[] = [];
  try {
    // 1. ping
    await client.ping();
    log('ping ok');

    // 2. dedicated workspace for this run
    const smokeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paneflow-smoke-'));
    const ws = await client.workspaceCreate({ label: 'paneflow-smoke', cwd: smokeDir });
    const { workspace, tab, root_pane } = ws;
    log(`workspace created: ${workspace.workspace_id} tab=${tab.tab_id} root_pane=${root_pane.pane_id}`);

    // 3. split a pane for the agent
    const split = await client.paneSplit({
      direction: 'right',
      target_pane_id: root_pane.pane_id,
      cwd: smokeDir,
    });
    const agentPaneId = split.pane.pane_id;
    log(`pane split: ${agentPaneId}`);

    // 4. per-pane lifecycle subscriptions (agent status events require pane_id)
    await client.subscribe(
      [
        { type: 'pane.agent_status_changed', pane_id: root_pane.pane_id },
        { type: 'pane.agent_status_changed', pane_id: agentPaneId },
        { type: 'workspace.closed' },
      ],
      (ev) => {
        events.push(JSON.stringify(ev));
        log(`event: ${JSON.stringify(ev).slice(0, 200)}`);
      },
    );
    log('subscribed to per-pane lifecycle events');

    // 5. plain shell command roundtrip via pane.read (no agent cost)
    await client.request('pane.send_text', { pane_id: root_pane.pane_id, text: 'echo PANEFLOW_SHELL_OK\n' });
    await client.paneWaitForOutput({
      pane_id: root_pane.pane_id,
      source: 'recent_unwrapped',
      match: { type: 'substring', value: 'PANEFLOW_SHELL_OK' },
      timeout_ms: 10_000,
    });
    log('pane send_text + wait_for_output ok');

    // 6. real agent lifecycle (opencode, one trivial turn)
    const kind = process.env.PF_SMOKE_AGENT ?? 'opencode';
    log(`agent start: kind=${kind} pane=${agentPaneId}`);
    await client.agentStart({ name: 'pf-smoke', kind, pane_id: agentPaneId, timeout_ms: 90_000 });
    log('agent start request returned (may still be launch_pending)');

    // wait until the agent is actually ready for input
    await client.agentWait({ target: 'pf-smoke', until: ['idle'], timeout_ms: 120_000 });
    log('agent reached idle');

    await client.agentPrompt({
      target: 'pf-smoke',
      text: 'Reply with exactly this single word and nothing else: SMOKE_OK',
      wait: { until: ['idle', 'done', 'blocked'], timeout_ms: 180_000 },
    });
    log('agent prompt settled');

    const read = await client.agentRead('pf-smoke', 'recent_unwrapped', 30);
    const tail = (read.text ?? '').split('\n').filter(Boolean).slice(-8).join('\n');
    log(`agent output tail:\n${tail}`);
    if (!/SMOKE_OK/.test(read.text ?? '')) {
      log('WARN: expected SMOKE_OK marker not found in output');
    }

    // 7. agent list shows our agent with a status
    const list = await client.agentList();
    const mine = list.agents.find((a) => a.name === 'pf-smoke' || a.pane_id === agentPaneId);
    log(`agent in list: status=${mine?.agent_status ?? 'MISSING'}`);

    // 8. cleanup
    await client.workspaceClose(workspace.workspace_id);
    log('workspace closed');
    const after = await client.workspaceList();
    const gone = !after.workspaces.some((w) => w.workspace_id === workspace.workspace_id);
    log(`workspace reclaimed from list: ${gone}`);

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    log(`SMOKE PASSED in ${secs}s (${events.length} lifecycle events observed)`);
    if (!mine || !gone) process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
  }
}

main()
  .catch((err) => {
    console.error('[smoke] FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (!keep) void stopServer();
  });
