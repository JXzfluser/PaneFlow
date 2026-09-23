import { useState } from 'react';
import { api } from '../api.js';

export interface EnvHealth {
  herdrOk: boolean;
  herdrVersion: string | null;
  env: {
    nodeVersion: string;
    agentsInstalled: string[];
    agentsMissing: string[];
  };
  agentKinds: string[];
}

/**
 * First-run wizard: three steps (Herdr → coding agent → connection test).
 * Shown when herdr is unreachable or no agent binary is installed.
 */
export function EnvWizard({ health, onDone }: { health: EnvHealth; onDone: () => void }) {
  const [checking, setChecking] = useState(false);
  const [snapshot, setSnapshot] = useState(health);

  const recheck = async () => {
    setChecking(true);
    try {
      const h = await api.health();
      setSnapshot({
        herdrOk: h.herdrOk,
        herdrVersion: h.herdrVersion ?? null,
        env: h.env,
        agentKinds: h.agentKinds,
      });
    } finally {
      setChecking(false);
    }
  };

  const copy = (text: string) => void navigator.clipboard.writeText(text);

  const herdrInstall = 'curl -fsSL https://herdr.dev/install.sh | sh';
  const agentPick = snapshot.env.agentsMissing.slice(0, 3);
  const agentInstall = agentPick.map((k) => `herdr integration install ${k}`).join('\n');
  const allGood = snapshot.herdrOk && snapshot.env.agentsInstalled.length > 0;

  return (
    <div className="modal-mask">
      <div className="modal" style={{ width: 'min(620px, 94vw)' }}>
        <h2>欢迎使用 PaneFlow</h2>
        <p style={{ color: 'var(--text-dim)' }}>
          PaneFlow 通过 <b>Herdr</b> 终端 Pane 驱动真实的编码 Agent（pi / opencode / claude…）。
          检测到本机环境尚未就绪，按下面三步完成初始化：
        </p>

        <div className="wiz-step">
          <div className="wiz-head">
            <span className={`dot ${snapshot.herdrOk ? 'ok' : 'bad'}`} />
            <b>第 1 步 · 安装 Herdr</b>
            {snapshot.herdrOk && <span className="badge done">已安装 {snapshot.herdrVersion ?? ''}</span>}
          </div>
          {!snapshot.herdrOk && (
            <>
              <pre className="wiz-cmd">{herdrInstall}<button className="wiz-copy" onClick={() => copy(herdrInstall)}>复制</button></pre>
              <p className="wiz-note">或参考 github.com/herdrdev/herdr 的安装说明；安装后 Herdr 常驻后台。</p>
            </>
          )}
        </div>

        <div className="wiz-step">
          <div className="wiz-head">
            <span className={`dot ${snapshot.env.agentsInstalled.length ? 'ok' : 'bad'}`} />
            <b>第 2 步 · 安装至少一个编码 Agent</b>
            {snapshot.env.agentsInstalled.length > 0 && (
              <span className="badge done">已装：{snapshot.env.agentsInstalled.join('、')}</span>
            )}
          </div>
          {snapshot.env.agentsInstalled.length === 0 && (
            <>
              <pre className="wiz-cmd">
                {agentInstall || 'herdr integration install pi'}
                <button className="wiz-copy" onClick={() => copy(agentInstall || 'herdr integration install pi')}>复制</button>
              </pre>
              <p className="wiz-note">以上任选其一（pi / opencode / claude…按你的喜好，装好后重检会出现在列表）。</p>
            </>
          )}
        </div>

        <div className="wiz-step">
          <div className="wiz-head">
            <span className={`dot ${allGood ? 'ok' : 'bad'}`} />
            <b>第 3 步 · 连接测试</b>
            {allGood && <span className="badge done">环境就绪 🎉</span>}
          </div>
          <p className="wiz-note">
            Node {snapshot.env.nodeVersion} · Herdr {snapshot.herdrOk ? `已连接（${snapshot.herdrVersion ?? '?'}）` : '未连接'}
          </p>
        </div>

        <div className="close-row">
          <button onClick={() => void recheck()} disabled={checking}>
            {checking ? '检测中…' : '🔄 我已安装，重新检测'}
          </button>
          <button className="primary" onClick={onDone}>
            {allGood ? '开始使用' : '稍后再说'}
          </button>
        </div>
      </div>
    </div>
  );
}
