import { useEffect, useState } from 'react';
import { api, connectWs, getSpace } from './api.js';
import { useStore } from './store.js';
import { SideNav } from './components/SideNav.jsx';
import { TasksView } from './components/TasksView.jsx';
import { OrchestrateView } from './components/OrchestrateView.jsx';
import { RunsCenter } from './components/RunsCenter.jsx';
import { ProjectsView } from './components/ProjectsView.jsx';
import { SettingsView } from './components/SettingsView.jsx';
import { Guide } from './components/Guide.jsx';
import { EnvWizard } from './components/EnvWizard.jsx';

let healthLogged = false; // dedupe across StrictMode double-mounts

export function App() {
  const view = useStore((s) => s.view);
  const log = useStore((s) => s.log);
  const setAgentKinds = useStore((s) => s.setAgentKinds);
  const setTemplates = useStore((s) => s.setTemplates);
  const setCwd = useStore((s) => s.setCwd);

  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const [guideOpen, setGuideOpen] = useState(false);
  const [wizard, setWizard] = useState<{
    herdrOk: boolean;
    herdrVersion: string | null;
    env: { nodeVersion: string; agentsInstalled: string[]; agentsMissing: string[]; recommendedAgentKind?: string | null };
    agentKinds: string[];
    recommendedAgentKind?: string | null;
  } | null>(null);

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
        // 默认 Agent：AE 自动推荐（已装优先 pi）> 本机已装首个 > 服务端清单首个（R7-③ 去前端硬编码）
        useStore.getState().setDefaultAgentKind(h.recommendedAgentKind ?? h.env.agentsInstalled[0] ?? h.agentKinds[0] ?? '');
        if (!healthLogged) {
          healthLogged = true;
          log(h.herdrOk ? 'info' : 'error', `Herdr ${h.herdrOk ? '已连接' : '不可达'}：${h.herdrSocket}`);
          log('info', '提示：第一次使用？点右上角「? 指南」查看五步上手教程');
        }
        if (!h.herdrOk || h.env.agentsInstalled.length === 0) {
          if (!localStorage.getItem('pf-wizard-dismissed')) setWizard(h);
        }
      })
      .catch((e) => log('error', `后端不可达：${String(e)}`));
    const restored = useStore.getState().restoreAutosave();
    if (restored) log('info', '已恢复上次未保存的画布（自动保存）');
    void api.listGraphs().then((r) => setTemplates(r.graphs));
    if (!useStore.getState().cwd) {
      // D2：不再写死 /tmp/paneflow-workspace（大概率不存在，点运行即报错）。
      // 优先沿用当前项目已配置的主仓根；没有就留空并给出可执行提示。
      void api
        .listSpaces()
        .then((r) => {
          if (useStore.getState().cwd) return; // 用户已手动填过，别覆盖
          const cur = getSpace();
          const sp = r.spaces.find((s) => s.id === cur) ?? r.spaces.find((s) => s.id === 'default');
          if (sp?.rootCwd) {
            setCwd(sp.rootCwd);
            log('info', `已采用项目「${sp.name}」的主仓根作为工作目录：${sp.rootCwd}`);
          } else {
            log('warn', '尚未设置流水线工作目录：请在顶栏「流水线工作目录」填写一个已存在的目录，或到「设 · 设置」配置项目主仓根。');
          }
        })
        .catch(() => {
          log('warn', '尚未设置流水线工作目录：请在顶栏「流水线工作目录」填写一个已存在的本地目录。');
        });
    }
    if (!localStorage.getItem('pf-guide-seen')) {
      setGuideOpen(true);
      localStorage.setItem('pf-guide-seen', '1');
    }
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app-with-nav">
      <SideNav />
      <div className="app-main-col">
        <div className="topbar topbar-global">
          <span className="brand" style={{ fontSize: 14 }}>PaneFlow</span>
          <span className="view-eyebrow">
            {view === 'tasks'
              ? 'TASKS · 任务'
              : view === 'orchestrate'
                ? 'ORCHESTRATE · 编排'
                : view === 'runs'
                  ? 'RUNS · 运行中心'
                  : view === 'projects'
                    ? 'PROJECTS · 项目'
                    : 'SETTINGS · 设置'}
          </span>
          <div className="spacer" />
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title={theme === 'dark' ? '切到浅色' : '切到暗夜'}
          >
            {theme === 'dark' ? '🌙' : '☀️'}
          </button>
          <button onClick={() => setGuideOpen(true)} title="使用指南">? 指南</button>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>v{__PF_VERSION__}</span>
        </div>
        {view === 'tasks' && <TasksView />}
        {view === 'orchestrate' && <OrchestrateView />}
        {view === 'runs' && <RunsCenter />}
        {view === 'projects' && <ProjectsView />}
        {view === 'settings' && <SettingsView />}
      </div>
      {wizard && (
        <EnvWizard
          health={wizard}
          onDone={() => {
            localStorage.setItem('pf-wizard-dismissed', '1');
            setWizard(null);
          }}
        />
      )}
      {guideOpen && <Guide onClose={() => setGuideOpen(false)} />}
    </div>
  );
}
