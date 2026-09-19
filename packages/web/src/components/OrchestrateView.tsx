import { useState } from 'react';
import { api } from '../api.js';
import { graphIssues, useStore } from '../store.js';
import { Canvas } from './Canvas.jsx';
import { StepList } from './StepList.jsx';
import { Palette } from './Palette.jsx';
import { PropertyPanel } from './PropertyPanel.jsx';
import { Console } from './Console.jsx';
import { RunDialog } from './RunDialog.jsx';
import { VariablesEditor } from './VariablesEditor.jsx';

type PaneMode = 'list' | 'canvas';
const PANE_KEY = 'pf-pane-mode';

export function OrchestrateView() {
  const graphName = useStore((s) => s.graphName);
  const renameGraph = useStore((s) => s.renameGraph);
  const toGraph = useStore((s) => s.toGraph);
  const clearCanvas = useStore((s) => s.clearCanvas);
  const log = useStore((s) => s.log);
  const runs = useStore((s) => s.runs);
  const activeRunId = useStore((s) => s.activeRunId);
  const openRun = useStore((s) => s.openRun);
  const setActiveRun = useStore((s) => s.setActiveRun);
  const cwd = useStore((s) => s.cwd);
  const setCwd = useStore((s) => s.setCwd);
  const setTemplates = useStore((s) => s.setTemplates);
  const setView = useStore((s) => s.setView);

  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [varsOpen, setVarsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [paneMode, setPaneMode] = useState<PaneMode>(() =>
    localStorage.getItem(PANE_KEY) === 'canvas' ? 'canvas' : 'list',
  );
  const activeRun = activeRunId ? runs[activeRunId] : null;
  const running = activeRun?.state === 'running';

  const switchPane = (mode: PaneMode) => {
    localStorage.setItem(PANE_KEY, mode);
    setPaneMode(mode);
  };

  const run = () => {
    const issues = graphIssues();
    if (issues.length) {
      log('error', `无法启动：${issues.join('；')}`);
      return;
    }
    if (!cwd.trim()) {
      log('error', '请先填写流水线工作目录（须已存在），或到「设 · 设置」配置项目主仓根');
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

  const syncPush = async () => {
    try {
      const st = await api.syncStatus();
      if (!st.configured) {
        log('warn', 'GitHub 沉淀未启用：请到设置页配置 GitHub Token 与默认目标仓库（owner/name）；环境变量 PF_GITHUB_REPO/PF_GITHUB_TOKEN 亦可，env 优先');
        return;
      }
      await api.syncPush();
      log('info', `模板沉淀已启动（异步推送到 ${st.repo}）`);
    } catch (e) {
      log('error', `沉淀失败：${(e as Error).message}`);
    }
  };

  const syncPull = async () => {
    try {
      const r = await api.syncPull();
      setTemplates((await api.listGraphs()).graphs);
      log('info', `已拉取 ${r.imported.length} 个云端模板${r.failed.length ? `，失败 ${r.failed.length}` : ''}`);
    } catch (e) {
      log('error', `拉取失败：${(e as Error).message}`);
    }
  };

  return (
    <>
      <div className="topbar">
        <div className="tb-group" title="当前画布的模板">
          <input className="gname" value={graphName} onChange={(e) => renameGraph(e.target.value)} placeholder="模板名" style={{ width: 150 }} />
          <button onClick={saveTemplate} title="保存模板（用左侧模板名）">💾</button>
        </div>

        <div className="tb-group">
          <button className="primary" title="回到「任务」：一句话描述需求，自动编排（可先看编排预告）" onClick={() => setView('tasks')}>
            ✎ 描述需求
          </button>
        </div>

        <div className="tb-group pane-switch" title="同一份编排的两种看法：清单给人读，画布给结构改">
          <button className={paneMode === 'list' ? 'on' : ''} onClick={() => switchPane('list')}>清单</button>
          <button className={paneMode === 'canvas' ? 'on' : ''} onClick={() => switchPane('canvas')}>画布</button>
        </div>

        <div className="tb-group" title="流水线运行">
          <input
            className={`gname${cwd ? '' : ' needs-attn'}`}
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="流水线工作目录（必填）"
            title={cwd ? '流水线工作目录' : '尚未设置：填一个已存在的本地目录，或到「设 · 设置」配置项目主仓根'}
            style={{ width: 180 }}
          />
          {!running ? (
            <button className="primary" onClick={run}>▶ 运行</button>
          ) : (
            <button className="danger" onClick={() => void stop()} title="停止流水线">⏹</button>
          )}
        </div>

        <div className="spacer" />

        <div className="tb-status">
          {activeRunId && (
            <select
              className="sm run-picker"
              value={activeRunId}
              onChange={(e) => openRun(e.target.value)}
              title="切换查看历史运行"
            >
              {Object.values(runs).map((r) => (
                <option key={r.runId} value={r.runId}>
                  {r.runId} · {r.dagName} · {r.state}
                </option>
              ))}
            </select>
          )}
          <div className="tb-more">
            <button title="更多（变量 / 云端沉淀 / 清空）" onClick={() => setMoreOpen((v) => !v)}>
              ⋯ 更多
            </button>
            {moreOpen && (
              <>
                <div className="tb-more-backdrop" onClick={() => setMoreOpen(false)} />
                <div className="tb-more-menu">
                  <button
                    className={varsOpen ? 'on' : ''}
                    onClick={() => {
                      setVarsOpen((v) => !v);
                      setMoreOpen(false);
                    }}
                  >
                    ⎇ 模板变量
                  </button>
                  <button onClick={() => { void syncPush(); setMoreOpen(false); }}>☁️ 沉淀到 GitHub</button>
                  <button onClick={() => { void syncPull(); setMoreOpen(false); }}>⬇️ 从 GitHub 拉取</button>
                  <button
                    onClick={() => {
                      clearCanvas();
                      setMoreOpen(false);
                    }}
                  >
                    🧹 清空画布
                  </button>
                </div>
              </>
            )}
          </div>
          <button onClick={() => setView('runs')} title="打开运行中心（多流水线总览）">🕘 运行中心</button>
        </div>
      </div>
      {varsOpen && <VariablesEditor />}
      <div className="main">
        <Palette />
        {paneMode === 'list' ? <StepList /> : <Canvas />}
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
