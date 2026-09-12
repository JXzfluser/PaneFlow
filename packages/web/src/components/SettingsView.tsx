import { useEffect, useState } from 'react';
import { api, getSpace } from '../api.js';
import { useStore } from '../store.js';

function GithubCredCard() {
  const log = useStore((s) => s.log);
  const [g, setG] = useState<{ tokenConfigured: boolean; defaultRepo: string }>({ tokenConfigured: false, defaultRepo: '' });
  const [token, setToken] = useState('');
  useEffect(() => {
    void fetch('/api/github/cred').then((r) => r.json()).then(setG);
  }, []);
  const save = async () => {
    try {
      await fetch('/api/github/cred', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(token ? { token } : {}), defaultRepo: g.defaultRepo }),
      }).then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
        const d = await r.json();
        setG((x) => ({ ...x, tokenConfigured: d.tokenConfigured }));
      });
      log('info', 'GitHub 凭据已保存（新启动的 Agent Pane 生效）');
    } catch (e) {
      log('error', `保存失败：${(e as Error).message}`);
    }
  };
  return (
    <>
      <label>GitHub Token {g.tokenConfigured && <span style={{ color: 'var(--ok)' }}>（已配置，留空保持不变）</span>}</label>
      <input
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="github_pat_… / ghp_…"
      />
      <label>默认仓库（owner/name）</label>
      <input
        value={g.defaultRepo}
        onChange={(e) => setG((x) => ({ ...x, defaultRepo: e.target.value }))}
        placeholder="owner/repo"
      />
      <button onClick={() => void save()}>保存</button>
    </>
  );
}

function GatewayCard() {
  const log = useStore((s) => s.log);
  const [g, setG] = useState({ baseUrl: '', freeModel: 'auto/best-free', enabled: false, keyConfigured: false });
  const [apiKey, setApiKey] = useState('');
  const [testing, setTesting] = useState<string>('');
  useEffect(() => {
    void fetch('/api/gateway').then((r) => r.json()).then(setG);
  }, []);
  const save = async () => {
    try {
      await fetch('/api/gateway', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: g.baseUrl,
          freeModel: g.freeModel,
          enabled: g.enabled,
          ...(apiKey ? { apiKey } : {}),
        }),
      }).then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      });
      log('info', '模型网关已保存（新启动的 Agent Pane 生效）');
    } catch (e) {
      log('error', `保存失败：${(e as Error).message}`);
    }
  };
  const test = async () => {
    setTesting('检测中…');
    await save();
    const r = await fetch('/api/gateway/test', { method: 'POST' }).then((x) => x.json());
    setTesting(r.ok ? `✓ 连通，${r.models} 个模型` : `✗ ${r.error ?? '失败'}`);
  };
  return (
    <>
      <label>网关地址</label>
      <input
        value={g.baseUrl}
        onChange={(e) => setG((x) => ({ ...x, baseUrl: e.target.value }))}
        placeholder="http://localhost:20128"
      />
      <label>API Key {g.keyConfigured && <span style={{ color: 'var(--ok)' }}>（已配置，留空保持不变）</span>}</label>
      <input
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder={g.keyConfigured ? '••••••••' : 'sk-…'}
      />
      <label>免费档模型 id（注入 ANTHROPIC_MODEL 等）</label>
      <input
        value={g.freeModel}
        onChange={(e) => setG((x) => ({ ...x, freeModel: e.target.value }))}
        placeholder="auto/best-free"
      />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
        <label style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          <input type="checkbox" checked={g.enabled} onChange={(e) => setG((x) => ({ ...x, enabled: e.target.checked }))} /> 启用注入
        </label>
        <button onClick={() => void test()}>{testing || '🔍 测试连通'}</button>
        <button className="primary" onClick={() => void save()}>保存</button>
      </div>
    </>
  );
}

interface Role {
  id: string;
  name: string;
  agentKind?: string;
  prePrompt?: string;
  env?: Record<string, string>;
}

function RolesEditor() {
  const log = useStore((s) => s.log);
  const [roles, setRoles] = useState<Role[]>([]);
  const [agentKinds, setAgentKinds] = useState<string[]>([]);
  useEffect(() => {
    void fetch('/api/roles').then((r) => r.json()).then((d) => setRoles(d.roles ?? []));
    void api.health().then((h) => setAgentKinds(h.agentKinds));
  }, []);
  const save = (next: Role[]) => {
    setRoles(next);
    void fetch('/api/roles', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roles: next }),
    }).then(async (r) => {
      if (!r.ok) log('error', (await r.json()).error ?? `HTTP ${r.status}`);
      else log('info', '角色库已保存');
    });
  };
  const patch = (idx: number, part: Partial<Role>) =>
    setRoles((rs) => rs.map((r, i) => (i === idx ? { ...r, ...part } : r)));
  return (
    <>
      {roles.map((r, i) => (
        <div key={r.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={r.name} onChange={(e) => patch(i, { name: e.target.value })} placeholder="角色名" style={{ flex: 1 }} />
            <select value={r.agentKind ?? ''} onChange={(e) => patch(i, { agentKind: e.target.value || undefined })} style={{ width: 140 }}>
              <option value="">（默认 Agent）</option>
              {agentKinds.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <button className="danger" title="删除角色" onClick={() => save(roles.filter((x) => x.id !== r.id))}>🗑</button>
          </div>
          <textarea
            value={r.prePrompt ?? ''}
            onChange={(e) => patch(i, { prePrompt: e.target.value })}
            placeholder="角色前置提示（渲染在节点指令之前），如：你是后端开发工程师，遵守团队分支与提交规范…"
            style={{ width: '100%', minHeight: 56, marginTop: 8, background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: 6, font: 'inherit' }}
          />
          <label style={{ display: 'block', color: 'var(--text-dim)', fontSize: 11, margin: '6px 0 3px' }}>
            角色环境变量（每行 key=值；典型：模型网关地址，节点级可覆盖）
          </label>
          <input
            value={Object.entries(r.env ?? {}).map(([k, v]) => `${k}=${v}`).join('  ')}
            onChange={(e) => {
              const env: Record<string, string> = {};
              for (const line of e.target.value.split(/\s+/)) {
                const idx = line.indexOf('=');
                if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
              }
              patch(i, { env: Object.keys(env).length ? env : undefined });
            }}
            placeholder="ANTHROPIC_BASE_URL=http://127.0.0.1:4000"
            style={{ width: '100%', background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: 5, font: 'inherit' }}
          />
        </div>
      ))}
      <button
        onClick={() =>
          save([...roles, { id: `role-${Date.now().toString(36)}`, name: `角色 ${roles.length + 1}` }])
        }
      >
        + 新增角色
      </button>
    </>
  );
}
interface SpaceProfile {
  id: string;
  name: string;
  createdAt: string;
  rootCwd?: string;
  description?: string;
  conventionFiles?: string[];
  skills?: string[];
}

/** 设置视图（B8 骨架 + B10 预置）：空间管理 / 项目档案 / 出站通知 / 环境。 */
export function SettingsView() {
  const log = useStore((s) => s.log);
  const spaceId = getSpace();
  const [profile, setProfile] = useState<SpaceProfile | null>(null);
  const [notify, setNotify] = useState<{ feishuWebhook: string; notifyEvents?: string[] }>({ feishuWebhook: '' });
  const [env, setEnv] = useState<{ herdrOk: boolean; herdrVersion: string | null; env: { agentsInstalled: string[] } } | null>(null);
  const [discover, setDiscover] = useState<{ markdowns: string[]; skills: string[]; repos: string[] } | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [browseDir, setBrowseDir] = useState<string | null>(null);
  const [browseList, setBrowseList] = useState<string[] | null>(null);

  useEffect(() => {
    if (spaceId !== 'default') {
      void fetch(`/api/spaces/${encodeURIComponent(spaceId)}`)
        .then((r) => r.json())
        .then((p) => setProfile(p as SpaceProfile));
    }
    void fetch('/api/notify/settings')
      .then((r) => r.json())
      .then((s) => setNotify({ feishuWebhook: s.feishuWebhook ?? '', notifyEvents: s.notifyEvents }));
    void api.health().then(setEnv);
  }, [spaceId]);

  const loadBrowse = async (dir: string) => {
    try {
      const d = await fetch(`/api/fs/browse?path=${encodeURIComponent(dir)}`).then((r) => r.json());
      setBrowseList(d.entries ?? []);
      setBrowseDir(d.dir ?? dir);
    } catch {
      setBrowseList([]);
    }
  };

  const saveProfile = async () => {
    if (!profile) return;
    try {
      await fetch(`/api/spaces/${encodeURIComponent(spaceId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootCwd: profile.rootCwd, description: profile.description }),
      });
      log('info', '项目档案已保存');
    } catch (e) {
      log('error', `保存失败：${(e as Error).message}`);
    }
  };

  const saveNotify = async () => {
    try {
      await fetch('/api/notify/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(notify.feishuWebhook && !notify.feishuWebhook.startsWith('(') ? { feishuWebhook: notify.feishuWebhook } : {}),
          notifyEvents: notify.notifyEvents ?? ['blocked', 'completed', 'failed'],
        }),
      }).then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      });
      log('info', '通知设置已保存');
    } catch (e) {
      log('error', `保存失败：${(e as Error).message}`);
    }
  };

  const events = ['blocked', 'completed', 'failed'];
  const activeEvents = notify.notifyEvents ?? ['blocked', 'completed', 'failed'];

  return (
    <div className="settings-view">
      <div className="settings-card">
        <h3>项目档案（当前空间：{spaceId}）</h3>
        {spaceId === 'default' ? (
          <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>
            默认空间用于快速体验。建议在左侧「+」新建一个项目空间（如 demo），再配置主仓根目录与约定文档。
          </p>
        ) : (
          <>
            <label>主仓根目录（仓库/文档/技能发现的基准路径）</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                value={profile?.rootCwd ?? ''}
                onChange={(e) => setProfile((p) => (p ? { ...p, rootCwd: e.target.value } : p))}
                placeholder="/home/user/work/my-project"
              />
              <button style={{ whiteSpace: 'nowrap' }} onClick={() => setBrowsing((b) => !b)}>📁 浏览</button>
            </div>
            {browsing && (
              <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 6, marginTop: 6, maxHeight: 180, overflowY: 'auto' }}>
                <div style={{ color: 'var(--text-dim)', fontSize: 11, marginBottom: 4 }}>{browseDir || '（父级）'}</div>
                {(browseList || []).map((d) => (
                  <div
                    key={d}
                    style={{ padding: '3px 6px', cursor: 'pointer', borderRadius: 4 }}
                    onClick={() => {
                      setBrowseDir((browseDir || '') + '/' + d);
                      setBrowseList(null);
                      void loadBrowse((browseDir || '') + '/' + d);
                    }}
                  >
                    📁 {d}
                  </div>
                ))}
                {browseList === null && <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>加载中…</span>}
              </div>
            )}
            <button
              style={{ marginTop: 8 }}
              onClick={() =>
                void fetch(`/api/fs/discover?root=${encodeURIComponent(profile?.rootCwd ?? '')}`)
                  .then((r) => r.json())
                  .then((d) => {
                    if (d.error) {
                      log('error', d.error);
                      return;
                    }
                    setDiscover({ markdowns: d.markdowns ?? [], skills: d.skills ?? [], repos: d.repos ?? [] });
                    // auto-select conventions on first discovery
                    setProfile((p) =>
                      p
                        ? {
                            ...p,
                            conventionFiles: p.conventionFiles ?? (d.markdowns ?? []).filter((f: string) => /AGENTS|CLAUDE/i.test(f)),
                            skills: p.skills ?? [],
                          }
                        : p,
                    );
                  })
              }
            >
              🔍 发现约定文档与技能
            </button>
            {discover && (
              <div style={{ display: 'flex', gap: 18, marginTop: 8, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <label>约定文档（勾选 = 运行时注入）</label>
                  <div style={{ maxHeight: 140, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 6 }}>
                    {discover.markdowns.map((f) => (
                      <label key={f} style={{ display: 'block', fontSize: 11.5 }}>
                        <input
                          type="checkbox"
                          checked={(profile?.conventionFiles ?? []).includes(f)}
                          onChange={(e) =>
                            setProfile((p) =>
                              p
                                ? {
                                    ...p,
                                    conventionFiles: e.target.checked
                                      ? [...(p.conventionFiles ?? []), f]
                                      : (p.conventionFiles ?? []).filter((x) => x !== f),
                                  }
                                : p,
                            )
                          }
                        />{' '}
                        {f}
                      </label>
                    ))}
                    {discover.markdowns.length === 0 && <span style={{ color: 'var(--text-dim)' }}>未发现 markdown</span>}
                  </div>
                </div>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <label>仓库（含 .git 的子目录，勾选 = 登记）</label>
                  <div style={{ maxHeight: 140, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 6 }}>
                    {(discover.repos ?? []).map((r) => (
                      <label key={r} style={{ display: 'block', fontSize: 11.5 }}>
                        <input
                          type="checkbox"
                          checked={(profile?.repos ?? []).includes(r)}
                          onChange={(e) =>
                            setProfile((p) =>
                              p
                                ? { ...p, repos: e.target.checked ? [...(p.repos ?? []), r] : (p.repos ?? []).filter((x) => x !== r) }
                                : p,
                            )
                          }
                        />{' '}
                        {r}
                      </label>
                    ))}
                    {(discover.repos ?? []).length === 0 && <span style={{ color: 'var(--text-dim)' }}>未发现仓库</span>}
                  </div>
                </div>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <label>技能（skills/ 目录）</label>
                  <div style={{ maxHeight: 140, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 6 }}>
                    {discover.skills.map((f) => (
                      <label key={f} style={{ display: 'block', fontSize: 11.5 }}>
                        <input
                          type="checkbox"
                          checked={(profile?.skills ?? []).includes(f)}
                          onChange={(e) =>
                            setProfile((p) =>
                              p
                                ? { ...p, skills: e.target.checked ? [...(p.skills ?? []), f] : (p.skills ?? []).filter((x) => x !== f) }
                                : p,
                            )
                          }
                        />{' '}
                        {f}
                      </label>
                    ))}
                    {discover.skills.length === 0 && <span style={{ color: 'var(--text-dim)' }}>未发现技能</span>}
                  </div>
                </div>
              </div>
            )}
            <label>描述</label>
            <input
              value={profile?.description ?? ''}
              onChange={(e) => setProfile((p) => (p ? { ...p, description: e.target.value } : p))}
              placeholder="一句话说明这个项目"
            />
            <button onClick={() => void saveProfile()}>保存档案</button>
          </>
        )}
      </div>

      <div className="settings-card">
        <h3>出站通知（飞书 webhook）</h3>
        <label>机器人 webhook URL（留空 = 关闭；仅支持飞书开放平台域名）</label>
        <input
          value={notify.feishuWebhook}
          onChange={(e) => setNotify((n) => ({ ...n, feishuWebhook: e.target.value }))}
          placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
        />
        <div style={{ display: 'flex', gap: 12, margin: '8px 0' }}>
          {events.map((ev) => (
            <label key={ev} style={{ fontSize: 12, color: 'var(--text-dim)' }}>
              <input
                type="checkbox"
                checked={activeEvents.includes(ev)}
                onChange={(e) =>
                  setNotify((n) => ({
                    ...n,
                    notifyEvents: e.target.checked
                      ? [...(n.notifyEvents ?? events), ev]
                      : (n.notifyEvents ?? events).filter((x) => x !== ev),
                  }))
                }
              />{' '}
              {ev === 'blocked' ? '等待审批' : ev === 'completed' ? '完成' : '失败'}
            </label>
          ))}
        </div>
        <button onClick={() => void saveNotify()}>保存通知设置</button>
      </div>

      <div className="settings-card">
        <h3>全局角色库</h3>
        <p style={{ color: 'var(--text-dim)', fontSize: 11.5, margin: '0 0 8px' }}>
          角色供画布 Agent 节点选择：继承默认 Agent 类型与前置提示。约定文档在上方「项目档案」按空间配置。
        </p>
        <RolesEditor />
      </div>

      <div className="settings-card">
        <h3>模型网关（OmniRoute 等）</h3>
        <p style={{ color: 'var(--text-dim)', fontSize: 11.5, margin: '0 0 8px' }}>
          配置后每个 Agent Pane 自动注入 OPENAI_*/ANTHROPIC_* 网关变量——模型请求统一走网关（免费档/自动切换由网关负责）。
        </p>
        <GatewayCard />
      </div>

      <div className="settings-card">
        <h3>GitHub 凭据（供流水线内 gh 命令使用）</h3>
        <p style={{ color: 'var(--text-dim)', fontSize: 11.5, margin: '0 0 8px' }}>
          解决企业托管账号（EMU）无法操作外部仓库的问题：注入 GH_TOKEN 后，Agent 的 gh issue/pr 命令将以此身份执行。
        </p>
        <GithubCredCard />
      </div>

      <div className="settings-card">
        <h3>环境</h3>
        {env && (
          <p style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            Herdr：{env.herdrOk ? `已连接 ${env.herdrVersion ?? ''}` : '未连接'} ·
            已安装 Agent：{env.env.agentsInstalled.join('、') || '无'}
          </p>
        )}
      </div>
    </div>
  );
}
