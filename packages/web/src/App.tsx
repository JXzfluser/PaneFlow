import { useEffect, useState } from 'react';
import { api, connectWs } from './api.js';
import { graphIssues, useStore, THEMES } from './store.js';
import { Canvas } from './components/Canvas.jsx';
import { Palette } from './components/Palette.jsx';
import { PropertyPanel } from './components/PropertyPanel.jsx';
import { Console } from './components/Console.jsx';
import { Guide } from './components/Guide.jsx';

let healthLogged = false; // dedupe across StrictMode double-mounts

export function App() {
  const graphName = useStore((s) => s.graphName);
  const renameGraph = useStore((s) => s.renameGraph);
  const toGraph = useStore((s) => s.toGraph);
  const clearCanvas = useStore((s) => s.clearCanvas);
  const log = useStore((s) => s.log);
  const wsOk = useStore((s) => s.wsOk);
  const herdrOk = useStore((s) => s.herdrOk);
  const runs = useStore((s) => s.runs);
  const activeRunId = useStore((s) => s.activeRunId);
  const setActiveRun = useStore((s) => s.setActiveRun);
  const cwd = useStore((s) => s.cwd);
  const setCwd = useStore((s) => s.setCwd);
  const setAgentKinds = useStore((s) => s.setAgentKinds);
  const setTemplates = useStore((s) => s.setTemplates);
  const nodes = useStore((s) => s.nodes);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);

  const [guideOpen, setGuideOpen] = useState(false);
  const [tbCollapsed, setTbCollapsed] = useState(() => localStorage.getItem('pf-tb-collapsed') === '1');
  const [tbHeight, setTbHeight] = useState(() => {
    const n = Number(localStorage.getItem('pf-tb-height'));
    return n >= 40 && n <= 140 ? n : 46;
  });
  const activeRun = activeRunId ? runs[activeRunId] : null;
  const running = activeRun?.state === 'running';

  const toggleTopbar = () => {
    setTbCollapsed((v) => {
      localStorage.setItem('pf-tb-collapsed', v ? '0' : '1');
      return !v;
    });
  };

  const onTopbarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = tbHeight;
    let last = startH;
    const move = (ev: MouseEvent) => {
      last = Math.min(140, Math.max(40, Math.round(startH + (startY - ev.clientY))));
      setTbHeight(last);
    };
    const up = () => {
      localStorage.setItem('pf-tb-height', String(last));
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const themeSeg = (
    <div className="theme-seg" title="主题切换（本地记忆）">
      {THEMES.map((t) => (
        <button
          key={t.id}
          className={theme === t.id ? 'active' : ''}
          onClick={() => setTheme(t.id)}
          title={`${t.label}主题`}
        >
          {t.icon}
        </button>
      ))}
    </div>
  );

  useEffect(() => {
    const off = connectWs(
      (run) => useStore.getState().applyRun(run),
      (ok) => useStore.getState().setHealth(useStore.getState().herdrOk, ok),
    );
    void api
      .health()
      .then((h) => {
        useStore.getState().setHealth(h.herdrOk, useStore.getState().wsOk);
        setAgentKinds(h.agentKinds);
        if (!healthLogged) {
          healthLogged = true;
          log(h.herdrOk ? 'info' : 'error', `Herdr ${h.herdrOk ? '已连接' : '不可达'}：${h.herdrSocket}`);
          log('info', '提示：第一次使用？点右上角「? 指南」查看五步上手教程');
        }
      })
      .catch((e) => log('error', `后端不可达：${String(e)}`));
    void api.listGraphs().then((r) => setTemplates(r.graphs));
    void api.listRuns().then((r) => {
      for (const run of r.runs) useStore.getState().applyRun(run);
      if (r.runs[0]) setActiveRun(r.runs[0].runId);
    });
    if (!useStore.getState().cwd) setCwd('/tmp/paneflow-workspace');
    // first-visit guide
    if (!localStorage.getItem('pf-guide-seen')) {
      setGuideOpen(true);
      localStorage.setItem('pf-guide-seen', '1');
    }
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async () => {
    const issues = graphIssues();
    if (issues.length) {
      log('error', `无法启动：${issues.join('；')}`);
      return;
    }
    if (!cwd.trim()) {
      log('error', '请先在顶栏设置流水线工作目录');
      return;
    }
    try {
      const { run: rec } = await api.startRun(toGraph(), cwd.trim());
      setActiveRun(rec.runId);
      log('info', `流水线已启动：${rec.runId}`);
    } catch (e) {
      log('error', `启动失败：${(e as Error).message}`);
    }
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
    <div className="app">
      <div
        className={`topbar${tbCollapsed ? ' collapsed' : ''}`}
        style={tbCollapsed ? undefined : { height: tbHeight }}
      >
        {tbCollapsed ? (
          <>
            <span className="brand">PaneFlow</span>
            {!running ? (
              <button className="primary" onClick={() => void run()} title="运行流水线">▶</button>
            ) : (
              <button className="danger" onClick={() => void stop()} title="停止流水线">⏹</button>
            )}
            <div className="spacer" />
            <div className="tb-status">
              <span title="画布与服务端的实时连接"><span className={`dot ${wsOk ? 'ok' : 'bad'}`} /></span>
              <span title="Herdr server 连接状态"><span className={`dot ${herdrOk === null ? 'unknown' : herdrOk ? 'ok' : 'bad'}`} /></span>
              {themeSeg}
              <button onClick={() => setGuideOpen(true)} title="使用指南">?</button>
              <button onClick={toggleTopbar} title="展开完整工具栏">⌄</button>
            </div>
          </>
        ) : (
          <>
            <span className="brand">PaneFlow</span>
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
                <button className="primary" onClick={() => void run()}>▶ 运行</button>
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
              <span title="画布与服务端的实时连接"><span className={`dot ${wsOk ? 'ok' : 'bad'}`} />WS</span>
              <span title="Herdr server 连接状态"><span className={`dot ${herdrOk === null ? 'unknown' : herdrOk ? 'ok' : 'bad'}`} />Herdr</span>
              {themeSeg}
              <button onClick={() => setGuideOpen(true)} title="使用指南">? 指南</button>
              <span style={{ fontSize: 11 }}>v0.1.0</span>
              <button onClick={toggleTopbar} title="收起为迷你工具条">⌃ 收起</button>
            </div>
          </>
        )}
        <div
          className="tb-resize"
          title="拖拽调整顶栏高度 · 双击复位"
          onMouseDown={onTopbarResize}
          onDoubleClick={() => {
            setTbHeight(46);
            localStorage.setItem('pf-tb-height', '46');
          }}
        />
      </div>
      <div className="main">
        <Palette />
        <Canvas />
        <PropertyPanel />
      </div>
      <Console />
      {guideOpen && <Guide onClose={() => setGuideOpen(false)} />}
    </div>
  );
}
