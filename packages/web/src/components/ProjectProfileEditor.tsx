import { useEffect, useState } from 'react';
import { api, fetchJson } from '../api.js';
import { useStore } from '../store.js';

/** v10-W 项目档案编辑器：从设置页整段迁入「项目」视图——档案是「每个项目一份」的配置，
 *  跟着项目卡走才顺。约定：只编辑当前项目（父级「编辑档案」先切换再展开，D4 全站响应式）。 */

interface SpaceProfile {
  id: string;
  name: string;
  createdAt: string;
  rootCwd?: string;
  description?: string;
  conventionFiles?: string[];
  skills?: string[];
  repos?: string[];
  defaultAgentKind?: string;
  agentOverride?: boolean;
  experienceInjection?: boolean;
  team?: TeamMember[];
  gatewayProfile?: string;
}

/** v9-B1/B3 班底成员：roleId 指向全局角色库，alias 是本项目昵称 */
interface TeamMember {
  roleId: string;
  alias?: string;
  note?: string;
}

interface Role {
  id: string;
  name: string;
}

interface GatewayProfileView {
  id: string;
  name: string;
  isCurrent: boolean;
}

/** v9-D2 项目钉档：本项目 Agent 固定用某档网关（全局切档不受影响）；「跟随全局」= current */
function GatewayPinField({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const log = useStore((s) => s.log);
  const [profiles, setProfiles] = useState<GatewayProfileView[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    void fetchJson<{ profiles?: GatewayProfileView[]; current: string | null }>('GET', '/api/gateway')
      .then((d) => {
        setProfiles(d.profiles ?? []);
        setCurrent(d.current);
      })
      .catch((e: Error) => log('error', `读取网关档位失败：${e.message}`));
  }, []);
  const dangling = Boolean(value) && !profiles.some((p) => p.id === value);
  return (
    <>
      <label title="本项目所有 Agent 固定用这一档网关，不受全局切档影响；钉的档被删了会自动回落全局生效档">
        网关档位（本项目钉档）
      </label>
      <select
        value={dangling ? '__dangling__' : value}
        onChange={(e) => onChange(e.target.value === '__dangling__' ? '' : e.target.value)}
        aria-label="本项目钉的网关档"
      >
        <option value="">
          跟随全局生效档{current ? `（${profiles.find((p) => p.id === current)?.name ?? ''}）` : ''}
        </option>
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.isCurrent ? '（全局生效）' : ''}
          </option>
        ))}
        {dangling && <option value="__dangling__">{value}（已删除，暂跟随全局）</option>}
      </select>
    </>
  );
}

/** v9-B3 班底卡片：列成员 / 选角色 / 改昵称 / 移除 / 单人试跑 / 一键装填标准五连 */
function TeamEditor({
  team,
  onChange,
  rootCwd,
  spaceId,
}: {
  team: TeamMember[];
  onChange: (t: TeamMember[]) => void;
  rootCwd: string | undefined;
  spaceId: string;
}) {
  const log = useStore((s) => s.log);
  const [roles, setRoles] = useState<Role[]>([]);
  const [busy, setBusy] = useState(false);

  const loadRoles = () =>
    fetchJson<{ roles?: Role[] }>('GET', '/api/roles')
      .then((d) => setRoles(d.roles ?? []))
      .catch((e: Error) => log('error', `读取角色库失败：${e.message}`));
  useEffect(() => {
    void loadRoles();
  }, []);

  const patch = (idx: number, part: Partial<TeamMember>) =>
    onChange(team.map((m, i) => (i === idx ? { ...m, ...part } : m)));
  const remove = (idx: number) => onChange(team.filter((_, i) => i !== idx));

  const installStandard = async () => {
    setBusy(true);
    try {
      const r = await fetchJson<{ profile: { team?: TeamMember[] } }>(
        'POST',
        `/api/spaces/${encodeURIComponent(spaceId)}/team/standard`,
      );
      onChange(r.profile.team ?? []);
      await loadRoles(); // 标准角色可能刚补进全局库
      log('info', '标准五连已装填（规划/实现/评审/验收/沉淀）——记得点「保存档案」');
    } catch (e) {
      log('error', `装填失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  /** B3 单人试跑：start→agent(role)→end 的最小图，走现链路 */
  const tryout = async (m: TeamMember) => {
    if (!m.roleId) {
      log('error', '这一位还没选角色');
      return;
    }
    if (!rootCwd?.trim()) {
      log('error', '单人试跑需要工作目录：先在上方填主仓根');
      return;
    }
    const name = m.alias || roles.find((r) => r.id === m.roleId)?.name || m.roleId;
    const now = new Date().toISOString();
    try {
      const r = await api.startRun(
        {
          version: 1,
          name: `trial-${m.roleId}-${Date.now().toString(36)}`,
          nodes: [
            { id: 'start', type: 'start', label: '开始', config: {} },
            {
              id: 'run',
              type: 'agent',
              label: `试跑 · ${name}`,
              config: {
                role: m.roleId,
                prompt: `这是成员「${name}」的单人试跑：请用 3-5 行自我介绍（专长、适合的活、交付习惯），不要读取或改动任何文件。`,
              },
            },
            { id: 'end', type: 'end', label: '结束', config: {} },
          ],
          edges: [
            { id: 't1', source: 'start', target: 'run' },
            { id: 't2', source: 'run', target: 'end' },
          ],
          metadata: { createdAt: now, updatedAt: now, description: `单人试跑：${name}` },
        },
        rootCwd.trim(),
      );
      log('info', `已发起「${name}」的试跑（${r.runId}）——去「运 · 运行」页看结果`);
    } catch (e) {
      log('error', `试跑失败：${(e as Error).message}`);
    }
  };

  return (
    <>
      <label title="班底=这个项目固定用的一组成员（取自全局角色库）；智能下发只会从班底点人">班底（{team.length} 人）</label>
      {team.length === 0 && (
        <p className="settings-hint">还没有班底：下发按默认班底跑。可一键装填「标准五连」（规划/实现/评审/验收/沉淀）。</p>
      )}
      {team.map((m, i) => {
        const dangling = m.roleId !== '' && !roles.some((r) => r.id === m.roleId);
        return (
          <div className="team-row" key={i}>
            <select
              value={m.roleId}
              onChange={(e) => patch(i, { roleId: e.target.value })}
              title="班底成员对应的全局角色"
            >
              <option value="">（选角色）</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
              {dangling && <option value={m.roleId}>{m.roleId}（库里已删）</option>}
            </select>
            <input
              value={m.alias ?? ''}
              onChange={(e) => patch(i, { alias: e.target.value || undefined })}
              placeholder="昵称（可选）"
              className="team-alias"
            />
            <input
              value={m.note ?? ''}
              onChange={(e) => patch(i, { note: e.target.value || undefined })}
              placeholder="备注（可选：擅长边界）"
              className="team-note"
            />
            <button className="link" onClick={() => void tryout(m)} title="单节点 run：只让这一位跑一句自我介绍">
              ▶ 试跑
            </button>
            <button className="link" onClick={() => remove(i)} title="移出班底">
              ✕
            </button>
          </div>
        );
      })}
      <div className="team-actions">
        <button onClick={() => onChange([...team, { roleId: '' }])} disabled={team.length >= 16}>
          + 加成员
        </button>
        <button onClick={() => void installStandard()} disabled={busy}>
          🪄 {busy ? '装填中…' : '一键装填标准五连'}
        </button>
      </div>
    </>
  );
}

/** 项目档案面板：主仓/约定发现/描述/Agent 选择/班底/网关钉档/经验注入，保存 = 全字段回写 PUT */
export function ProjectProfileEditor({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const log = useStore((s) => s.log);
  const agentKinds = useStore((s) => s.agentKinds);
  const [profile, setProfile] = useState<SpaceProfile | null>(null);
  const [env, setEnv] = useState<{
    herdrOk: boolean;
    recommendedAgentKind?: string | null;
    env: { agentsInstalled: string[] };
  } | null>(null);
  const [discover, setDiscover] = useState<{ markdowns: string[]; skills: string[]; repos: string[] } | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [recentRoots, setRecentRoots] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('pf-recent-roots') ?? '[]') as string[]; } catch { return []; }
  });
  const [browseDir, setBrowseDir] = useState<string | null>(null);
  const [browseList, setBrowseList] = useState<string[] | null>(null);

  useEffect(() => {
    setProfile(null);
    setDiscover(null);
    setBrowsing(false);
    setBrowseDir(null);
    setBrowseList(null);
    // AE：默认项目也要能配「项目默认 Agent/统一覆盖」——档案照常读取（表单仅呈现可配项）
    void fetchJson<SpaceProfile>('GET', `/api/spaces/${encodeURIComponent(projectId)}`)
      .then(setProfile)
      .catch((e: Error) => log('error', `读取项目档案失败：${e.message}`));
    void api.health().then((h) =>
      setEnv({ herdrOk: h.herdrOk, recommendedAgentKind: h.recommendedAgentKind, env: { agentsInstalled: h.env.agentsInstalled } }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const loadBrowse = async (dir: string) => {
    try {
      const d = await fetchJson<{ entries?: string[]; dir?: string }>('GET', `/api/fs/browse?path=${encodeURIComponent(dir)}`);
      setBrowseList(d.entries ?? []);
      setBrowseDir(d.dir ?? dir);
    } catch {
      setBrowseList([]);
    }
  };

  const saveProfile = async () => {
    if (!profile) return;
    try {
      // 全字段回写：PUT 是 merge 语义，漏发的键会保住旧值——勾选过的约定/技能/仓库必须随表单一并发出
      await fetchJson<unknown>('PUT', `/api/spaces/${encodeURIComponent(projectId)}`, {
        rootCwd: profile.rootCwd,
        description: profile.description,
        conventionFiles: profile.conventionFiles ?? [],
        skills: profile.skills ?? [],
        repos: profile.repos ?? [],
        defaultAgentKind: profile.defaultAgentKind ?? '',
        agentOverride: !!profile.agentOverride,
        experienceInjection: profile.experienceInjection !== false,
        team: profile.team ?? [], // v9-B1：漏发=保住旧班底，但清空必须发得出去
        gatewayProfile: profile.gatewayProfile ?? '', // v9-D2：空串=取消钉档，跟随全局
      });
      if (profile?.rootCwd) {
        const next = [profile.rootCwd, ...recentRoots.filter((x) => x !== profile.rootCwd)].slice(0, 5);
        setRecentRoots(next);
        localStorage.setItem('pf-recent-roots', JSON.stringify(next));
      }
      log('info', `项目「${profile.name || projectId}」档案已保存`);
    } catch (e) {
      log('error', `保存失败：${(e as Error).message}`);
    }
  };

  // AE/I2 Agent 选择控件：默认项目档案表单虽精简，这几个必须可配（实机阻塞点）
  const installedKinds = (env?.env.agentsInstalled ?? []).filter((k) => (agentKinds as readonly string[]).includes(k));
  const otherKinds = agentKinds.filter((k) => !installedKinds.includes(k));
  const pickKind = (k: string) =>
    setProfile((p) => (p ? { ...p, defaultAgentKind: k, ...(k ? {} : { agentOverride: false }) } : p));
  const agentControls = (
    <>
      <label title="节点/角色没指定 Agent 类型时用它；智能下发 Planner 也用它。「自动」= 本机已装里挑（pi > opencode > codex > claude）">
        默认 Agent
      </label>
      <div className="agent-chips" role="radiogroup" aria-label="默认 Agent">
        <button
          type="button"
          role="radio"
          aria-checked={!profile?.defaultAgentKind}
          className={`agent-chip${!profile?.defaultAgentKind ? ' on' : ''}`}
          onClick={() => pickKind('')}
        >
          自动{env?.recommendedAgentKind ? ` · ${env.recommendedAgentKind}` : '（检测中…）'}
        </button>
        {installedKinds.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={profile?.defaultAgentKind === k}
            className={`agent-chip${profile?.defaultAgentKind === k ? ' on' : ''}`}
            onClick={() => pickKind(k)}
          >
            {k}
          </button>
        ))}
      </div>
      {otherKinds.length > 0 && (
        <details className="settings-more">
          <summary>本机未装的 {otherKinds.length} 个 CLI（谨慎选择，点了起不来）</summary>
          <div className="agent-chips">
            {otherKinds.map((k) => (
              <button
                key={k}
                type="button"
                className={`agent-chip dim${profile?.defaultAgentKind === k ? ' on' : ''}`}
                onClick={() => pickKind(k)}
              >
                {k}
              </button>
            ))}
          </div>
        </details>
      )}
      <div className="stack">
        <label
          className="settings-check"
          title="本项目所有 Agent 一律用上面的默认值——包括旧模板里钉死的类型。配合「模型网关」= 启动的 agent 全部统一走网关模型。"
        >
          <input
            type="checkbox"
            disabled={!profile?.defaultAgentKind}
            checked={!!profile?.agentOverride}
            onChange={(e) => setProfile((p) => (p ? { ...p, agentOverride: e.target.checked } : p))}
          />{' '}
          统一覆盖：强制所有节点用「{profile?.defaultAgentKind || '默认'}」
        </label>
        <label
          className="settings-check"
          title="同模板有绿 run 时，其「实填变量+断言清单+成本画像」会自动附进新单首个 Agent 节点的上下文。关掉即恢复纯现场发挥。"
        >
          <input
            type="checkbox"
            checked={profile?.experienceInjection !== false}
            onChange={(e) => setProfile((p) => (p ? { ...p, experienceInjection: e.target.checked } : p))}
          />{' '}
          上次成功跑过的变量/验收/成本，自动喂给下一单
        </label>
      </div>
    </>
  );

  return (
    <section className="settings-card project-profile" id="project-profile">
      <div className="profile-head">
        <h3>项目档案 · {profile?.name || projectId}</h3>
        <button className="ghost" onClick={onClose} title="收起档案面板">
          收起 ✕
        </button>
      </div>
      {!profile ? (
        <p className="settings-hint">读取档案中…</p>
      ) : projectId === 'default' ? (
        <>
          <p className="settings-hint">
            默认项目用于快速体验。建议用上方「+ 新建项目」建一个真实项目（如 demo），再配置主仓根目录与约定文档。
            下面这几项（AE Agent 选择 / I2 经验注入）在默认项目同样可配：
          </p>
          {agentControls}
          <div className="settings-actions">
            <button className="primary" onClick={() => void saveProfile()}>
              保存档案
            </button>
          </div>
        </>
      ) : (
        <>
          <label>主仓根目录（仓库/文档/技能发现的基准路径）</label>
          <div className="settings-row">
            <input
              value={profile.rootCwd ?? ''}
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
              void fetchJson<{ error?: string; markdowns?: string[]; skills?: string[]; repos?: string[] }>(
                'GET',
                `/api/fs/discover?root=${encodeURIComponent(profile.rootCwd ?? '')}`,
              )
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
                          conventionFiles: p.conventionFiles ?? (d.markdowns ?? []).filter((f) => /AGENTS|CLAUDE/i.test(f)),
                          skills: p.skills ?? [],
                        }
                      : p,
                  );
                })
                .catch((e: Error) => log('error', `发现失败：${e.message}`))
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
                        checked={(profile.conventionFiles ?? []).includes(f)}
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
                        checked={(profile.repos ?? []).includes(r)}
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
                        checked={(profile.skills ?? []).includes(f)}
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
            value={profile.description ?? ''}
            onChange={(e) => setProfile((p) => (p ? { ...p, description: e.target.value } : p))}
            placeholder="一句话说明这个项目"
          />
          {agentControls}
          <TeamEditor
            team={profile.team ?? []}
            onChange={(t) => setProfile((p) => (p ? { ...p, team: t } : p))}
            rootCwd={profile.rootCwd}
            spaceId={projectId}
          />
          <GatewayPinField
            value={profile.gatewayProfile ?? ''}
            onChange={(id) => setProfile((p) => (p ? { ...p, gatewayProfile: id } : p))}
          />
          <div className="settings-actions">
            <button className="primary" onClick={() => void saveProfile()}>
              保存档案
            </button>
          </div>
        </>
      )}
    </section>
  );
}
