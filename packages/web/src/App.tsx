import { useEffect, useState } from 'react';
import { api, connectWs } from './api.js';
import { useStore } from './store.js';
import { SideNav } from './components/SideNav.jsx';
import { OrchestrateView } from './components/OrchestrateView.jsx';
import { RunsCenter } from './components/RunsCenter.jsx';
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

  const [guideOpen, setGuideOpen] = useState(false);
  const [wizard, setWizard] = useState<{
    herdrOk: boolean;
    herdrVersion: string | null;
    env: { nodeVersion: string; agentsInstalled: string[]; agentsMissing: string[] };
    agentKinds: string[];
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
    void api.listGraphs().then((r) => setTemplates(r.graphs));
    if (!useStore.getState().cwd) setCwd('/tmp/paneflow-workspace');
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
          <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
            {view === 'orchestrate' ? '编排画布' : view === 'runs' ? '运行中心' : '设置'}
          </span>
          <div className="spacer" />
          <button onClick={() => setGuideOpen(true)} title="使用指南">? 指南</button>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>v0.2.0</span>
        </div>
        {view === 'orchestrate' && <OrchestrateView />}
        {view === 'runs' && <RunsCenter />}
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
