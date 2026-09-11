import { useState } from 'react';
import { api, connectWs } from '../api.js';
import { graphIssues, useStore } from '../store.js';
import { Canvas } from './Canvas.jsx';
import { Palette } from './Palette.jsx';
import { PropertyPanel } from './PropertyPanel.jsx';
import { Console } from './Console.jsx';
import { RunDialog } from './RunDialog.jsx';

export function OrchestrateView() {
  const graphName = useStore((s) => s.graphName);
  const renameGraph = useStore((s) => s.renameGraph);
  const toGraph = useStore((s) => s.toGraph);
  const clearCanvas = useStore((s) => s.clearCanvas);
  const log = useStore((s) => s.log);
  const runs = useStore((s) => s.runs);
  const activeRunId = useStore((s) => s.activeRunId);
  const setActiveRun = useStore((s) => s.setActiveRun);
  const cwd = useStore((s) => s.cwd);
  const setCwd = useStore((s) => s.setCwd);
  const setAgentKinds = useStore((s) => s.setAgentKinds);
  const setTemplates = useStore((s) => s.setTemplates);
  const setView = useStore((s) => s.setView);

  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const activeRun = activeRunId ? runs[activeRunId] : null;
  const running = activeRun?.state === 'running';

  const run = () => {
    const issues = graphIssues();
    if (issues.length) {
      log('error', `无法启动：${issues.join('；')}`);
      return;
    }
    setRunDialogOpen(true);
  };

  const stop = async () => {
    if (!activeRunId) return;
    try {
      await api.stopRun(activeRunId);
      log('warn', '已发送停止指令（会先打断运行中的 Agent）…');
    } catch (e) {
      log('error', `停止失败：${(e as Error).message}`);
    }
  };

  const saveTemplate = async () => {
    const name = graphName.trim();
    if (!name || name === '未命名流水线') {
      log('error', '请先在顶栏输入框填写模板名（字母/数字/-/_）再保存');
      return;
    }
    try {
      await api.saveGraph({ ...toGraph(), name });
      setTemplates((await api.listGraphs()).graphs);
      log('info', `模板「${name}」已保存`);
    } catch (e) {
      log('error', `保存失败：${(e as Error).message}`);
    }
  };

  return (
    <>
      <div className="topbar">
        <div className="tb-group" title="当前画布的模板">
          <input className="gname" value={graphName} onChange={(e) => renameGraph(e.target.value)} placeholder="模板名" style={{ width: 160 }} />
          <button onClick={saveTemplate}>💾 保存模板</button>
        </div>
        <div className="tb-group" title="GitHub 模板沉淀（可选，需服务端配置）">
          <button
            onClick={async () => {
              try {
                const st = await api.syncStatus();
                if (!st.configured) {
                  log('warn', 'GitHub 沉淀未启用：需配置 PF_GITHUB_REPO / PF_GITHUB_TOKEN');
                  return;
                }
                await api.syncPush();
                log('info', `模板沉淀已启动（异步推送到 ${st.repo}）`);
              } catch (e) {
                log('error', `沉淀失败：${(e as Error).message}`);
              }
            }}
          >
            ☁️ 沉淀
          </button>
          <button
            onClick={async () => {
              try {
                const r = await api.syncPull();
                setTemplates((await api.listGraphs()).graphs);
                log('info', `已拉取 ${r.imported.length} 个云端模板${r.failed.length ? `，失败 ${r.failed.length}` : ''}`);
              } catch (e) {
                log('error', `拉取失败：${(e as Error).message}`);
              }
            }}
          >
            ⬇️ 拉取
          </button>
        </div>
        <div className="tb-group" title="流水线运行">
          <input
            className="gname"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="流水线工作目录"
            title="流水线工作目录（须已存在）"
            style={{ width: 190 }}
          />
          {!running ? (
            <button className="primary" onClick={run}>▶ 运行</button>
          ) : (
            <button className="danger" onClick={() => void stop()}>⏹ 停止</button>
          )}
          <button onClick={clearCanvas} title="清空画布">清空</button>
        </div>
        <div className="spacer" />
        <div className="tb-status">
          {activeRunId && (
            <select
              value={activeRunId}
              onChange={(e) => setActiveRun(e.target.value)}
              title="切换查看历史运行"
              style={{ background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 6px', maxWidth: 230 }}
            >
              {Object.values(runs).map((r) => (
                <option key={r.runId} value={r.runId}>
                  {r.runId} · {r.dagName} · {r.state}
                </option>
              ))}
            </select>
          )}
          <button onClick={() => setView('runs')} title="打开运行中心（多流水线总览）">🕘 迏行中心</button>
        </div>
      </div>
      <div className="main">
        <Palette />
        <Canvas />
        <PropertyPanel />
      </div>
      <Console />
      {runDialogOpen && (
        <RunDialog
          graph={toGraph()}
          onClose={() => setRunDialogOpen(false)}
          onStarted={(runId) => setActiveRun(runId)}
        />
      )}
    </>
  );
}
