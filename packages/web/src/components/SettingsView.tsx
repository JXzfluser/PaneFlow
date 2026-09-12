import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.js';

/** 设置页章节：左侧导航 + 右侧分区，避免 6 张卡片平铺到底 */
const SECTIONS: { id: string; label: string; icon: string }[] = [
  { id: 'space', label: '项目档案', icon: '📁' },
  { id: 'notify', label: '出站通知', icon: '🔔' },
  { id: 'roles', label: '角色库', icon: '👤' },
  { id: 'gateway', label: '模型网关', icon: '🌐' },
  { id: 'github', label: 'GitHub 凭据', icon: '🐙' },
  { id: 'env', label: '环境', icon: '🧩' },
];

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
      <label>
        GitHub Token {g.tokenConfigured && <span className="inline-ok">（已配置，留空保持不变）</span>}
      </label>
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
      <div className="settings-actions">
        <button className="primary" onClick={() => void save()}>
          保存凭据
        </button>
      </div>
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
      <label>
        API Key {g.keyConfigured && <span className="inline-ok">（已配置，留空保持不变）</span>}
      </label>
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
      <label className="settings-check">
        <input type="checkbox" checked={g.enabled} onChange={(e) => setG((x) => ({ ...x, enabled: e.target.checked }))} />
        启用注入
      </label>
      <div className="settings-actions">
        {testing && <span className="settings-action-note">{testing}</span>}
        <button onClick={() => void test()}>🔍 测试连通</button>
        <button className="primary" onClick={() => void save()}>
          保存网关
        </button>
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
        <div className="role-card" key={r.id}>
          <div className="role-card-head">
            <input
              value={r.name}
              onChange={(e) => patch(i, { name: e.target.value })}
              placeholder="角色名"
              className="role-name"
            />
            <select
              value={r.agentKind ?? ''}
              onChange={(e) => patch(i, { agentKind: e.target.value || undefined })}
              title="该角色默认使用的 Agent 类型"
            >
              <option value="">（默认 Agent）</option>
              {agentKinds.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <button className="icon danger" title="删除角色" onClick={() => save(roles.filter((x) => x.id !== r.id))}>
              🗑
            </button>
          </div>
          <textarea
            value={r.prePrompt ?? ''}
            onChange={(e) => patch(i, { prePrompt: e.target.value })}
            placeholder="角色前置提示（渲染在节点指令之前），如：你是后端开发工程师，遵守团队分支与提交规范…"
          />
          <label>角色环境变量（每行 key=值；典型：模型网关地址，节点级可覆盖）</label>
          <input
            value={Object.entries(r.env ?? {})
              .map(([k, v]) => `${k}=${v}`)
              .join('  ')}
            onChange={(e) => {
              const env: Record<string, string> = {};
              for (const line of e.target.value.split(/\s+/)) {
                const idx = line.indexOf('=');
                if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
              }
              patch(i, { env: Object.keys(env).length ? env : undefined });
            }}
            placeholder="ANTHROPIC_BASE_URL=http://127.0.0.1:4000"
          />
        </div>
      ))}
      <button
        className="ghost"
        onClick={() => save([...roles, { id: `role-${Date.now().toString(36)}`, name: `角色 ${roles.length + 1}` }])}
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
  repos?: string[];
}

/** 设置视图：左侧章节导航 + 右侧分区（原为 6 张卡片平铺 + 大量内联样式）。 */
export function SettingsView() {
  const log = useStore((s) => s.log);
  // 响应式读当前空间（D4）：侧栏切换后本页自动跟随刷新
  const spaceId = useStore((s) => s.space);
  const [profile, setProfile] = useState<SpaceProfile | null>(null);
  const [notify, setNotify] = useState<{ feishuWebhook: string; notifyEvents?: string[] }>({ feishuWebhook: '' });
  const [env, setEnv] = useState<{ herdrOk: boolean; herdrVersion: string | null; env: { agentsInstalled: string[] } } | null>(null);
  const [discover, setDiscover] = useState<{ markdowns: string[]; skills: string[]; repos: string[] } | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [recentRoots, setRecentRoots] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('pf-recent-roots') ?? '[]') as string[]; } catch { return []; }
  });
  const [browseDir, setBrowseDir] = useState<string | null>(null);
  const [browseList, setBrowseList] = useState<string[] | null>(null);
  const [active, setActive] = useState(SECTIONS[0]?.id ?? 'space');
  const bodyRef = useRef<HTMLDivElement>(null);

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

  // 滚动时高亮当前章节
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onScroll = () => {
      let cur = SECTIONS[0]?.id ?? 'space';
      for (const s of SECTIONS) {
        const node = document.getElementById(`sec-${s.id}`);
        if (node && node.getBoundingClientRect().top <= 140) cur = s.id;
      }
      setActive(cur);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const jump = (id: string) => {
    setActive(id);
    document.getElementById(`sec-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

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
      if (profile?.rootCwd) {
        const next = [profile.rootCwd, ...recentRoots.filter((x) => x !== profile.rootCwd)].slice(0, 5);
        setRecentRoots(next);
        localStorage.setItem('pf-recent-roots', JSON.stringify(next));
      }
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
      <nav className="settings-nav" aria-label="设置章节">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`settings-nav-item${active === s.id ? ' on' : ''}`}
            onClick={() => jump(s.id)}
          >
            <span className="settings-nav-icon">{s.icon}</span>
            {s.label}
          </button>
        ))}
      </nav>

      <div className="settings-body" ref={bodyRef}>
        <section className="settings-card" id="sec-space">
          <h3>项目档案</h3>
          <p className="settings-hint">当前空间：<b>{spaceId}</b></p>
          {spaceId === 'default' ? (
            <p className="settings-hint">
              默认空间用于快速体验。建议在左侧「+」新建一个项目空间（如 demo），再配置主仓根目录与约定文档。
            </p>
          ) : (
            <>
              <label>主仓根目录（仓库/文档/技能发现的基准路径）</label>
              <div className="settings-row">
                <input
                  value={profile?.rootCwd ?? ''}
                  onChange={(e) => setProfile((p) => (p ? { ...p, rootCwd: e.target.value } : p))}
                  placeholder="/home/user/work/my-project"
                />
                <button onClick={() => setBrowsing((b) => !b)}>📁 浏览</button>
              </div>
              <div className="settings-row wrap recent-roots">
                <span className="settings-hint">最近：</span>
                {recentRoots.slice(0, 3).map((r) => (
                  <button
                    key={r}
                    className="sm"
                    title={r}
                    onClick={() => setProfile((p) => (p ? { ...p, rootCwd: r } : p))}
                  >
                    {r.split('/').pop() || r}
                  </button>
                ))}
                <span
                  className="settings-dropzone"
                  title="拖拽文件夹到此可填入路径"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const item = e.dataTransfer?.items?.[0];
                    const entry = item?.webkitGetAsEntry?.() as { fullPath?: string } | null;
                    if (entry?.fullPath) setProfile((p) => (p ? { ...p, rootCwd: entry.fullPath } : p));
                  }}
                >
                  ⤵ 拖拽
                </span>
              </div>
              {browsing && (
                <div className="settings-listbox settings-browse">
                  <div className="settings-hint">{browseDir || '（父级）'}</div>
                  {(browseList || []).map((d) => (
                    <div
                      key={d}
                      className="settings-browse-item"
                      onClick={() => {
                        setBrowseDir((browseDir || '') + '/' + d);
                        setBrowseList(null);
                        void loadBrowse((browseDir || '') + '/' + d);
                      }}
                    >
                      📁 {d}
                    </div>
                  ))}
                  {browseList === null && <span className="settings-hint">加载中…</span>}
                </div>
              )}
              <button
                className="ghost"
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
                <div className="settings-discover">
                  <div>
                    <label>约定文档（勾选 = 运行时注入）</label>
                    <div className="settings-listbox">
                      {discover.markdowns.map((f) => (
                        <label key={f} className="settings-check">
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
                          />
                          {f}
                        </label>
                      ))}
                      {discover.markdowns.length === 0 && <span className="settings-hint">未发现 markdown</span>}
                    </div>
                  </div>
                  <div>
                    <label>仓库（含 .git 的子目录，勾选 = 登记）</label>
                    <div className="settings-listbox">
                      {(discover.repos ?? []).map((r) => (
                        <label key={r} className="settings-check">
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
                          />
                          {r}
                        </label>
                      ))}
                      {(discover.repos ?? []).length === 0 && <span className="settings-hint">未发现仓库</span>}
                    </div>
                  </div>
                  <div>
                    <label>技能（skills/ 目录）</label>
                    <div className="settings-listbox">
                      {discover.skills.map((f) => (
                        <label key={f} className="settings-check">
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
                          />
                          {f}
                        </label>
                      ))}
                      {discover.skills.length === 0 && <span className="settings-hint">未发现技能</span>}
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
              <div className="settings-actions">
                <button className="primary" onClick={() => void saveProfile()}>
                  保存档案
                </button>
              </div>
            </>
          )}
        </section>

        <section className="settings-card" id="sec-notify">
          <h3>出站通知（飞书 webhook）</h3>
          <label>机器人 webhook URL（留空 = 关闭；仅支持飞书开放平台域名）</label>
          <input
            value={notify.feishuWebhook}
            onChange={(e) => setNotify((n) => ({ ...n, feishuWebhook: e.target.value }))}
            placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
          />
          <div className="settings-row wrap">
            {events.map((ev) => (
              <label key={ev} className="settings-check">
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
                />
                {ev === 'blocked' ? '等待审批' : ev === 'completed' ? '完成' : '失败'}
              </label>
            ))}
          </div>
          <div className="settings-actions">
            <button className="primary" onClick={() => void saveNotify()}>
              保存通知设置
            </button>
          </div>
        </section>

        <section className="settings-card" id="sec-roles">
          <h3>全局角色库</h3>
          <p className="settings-hint">
            角色供画布 Agent 节点选择：继承默认 Agent 类型与前置提示。约定文档在上方「项目档案」按空间配置。
          </p>
          <RolesEditor />
        </section>

        <section className="settings-card" id="sec-gateway">
          <h3>模型网关（OmniRoute 等）</h3>
          <p className="settings-hint">
            配置后每个 Agent Pane 自动注入 OPENAI_*/ANTHROPIC_* 网关变量——模型请求统一走网关（免费档/自动切换由网关负责）。
          </p>
          <GatewayCard />
        </section>

        <section className="settings-card" id="sec-github">
          <h3>GitHub 凭据（供流水线内 gh 命令使用）</h3>
          <p className="settings-hint">
            解决企业托管账号（EMU）无法操作外部仓库的问题：注入 GH_TOKEN 后，Agent 的 gh issue/pr 命令将以此身份执行。
          </p>
          <GithubCredCard />
        </section>

        <section className="settings-card" id="sec-env">
          <h3>环境</h3>
          {env && (
            <p className="settings-hint">
              Herdr：{env.herdrOk ? `已连接 ${env.herdrVersion ?? ''}` : '未连接'} · 已安装 Agent：
              {env.env.agentsInstalled.join('、') || '无'}
            </p>
          )}
          <div className="settings-actions">
            <button onClick={() => void api.health().then(setEnv)}>🔄 重新检测</button>
          </div>
        </section>
      </div>
    </div>
  );
}
