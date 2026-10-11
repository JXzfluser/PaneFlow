import { useEffect, useState } from 'react';
import { fetchJson, getSpace } from '../api.js';
import { useStore } from '../store.js';
import { buildMemberCards, type MemberCard, type RoleOverallMetrics, type TeamViewRole } from '../team-view.js';
import type { TeamMemberLite } from '../team-bar.js';
import { Icon } from './Icon.js';

/**
 * v19-R3 「班底」目的地：每枚成员卡回答三问——他在不在 / 他会干什么 / 最近干得怎么样。
 * 取数全走既有 API（health/gateway/spaces/:id/roles/roles/:id/profile），零新判据；
 * 组装逻辑住在 team-view.ts 纯函数（单测口子）。能力面讲条目引用账，这一面讲人——互不吞并。
 */

interface HealthWire {
  env?: { agentsInstalled?: string[] };
  recommendedAgentKind?: string | null;
}
interface GatewayWire {
  enabled: boolean;
  freeModel?: string;
  current?: string;
}
interface ProfileWire {
  name?: string;
  team?: TeamMemberLite[];
  defaultAgentKind?: string;
}
interface RoleProfileWire {
  role?: { id: string };
  overall?: RoleOverallMetrics;
}

export function TeamView() {
  const space = useStore((s) => s.space);
  const setView = useStore((s) => s.setView);
  const [state, setState] = useState<{ phase: 'loading' } | { phase: 'ready'; cards: MemberCard[]; spaceName: string; teamEmpty: boolean } | { phase: 'error'; why: string }>({ phase: 'loading' });

  useEffect(() => {
    let alive = true;
    setState({ phase: 'loading' });
    (async () => {
      const [health, gateway, profile, roles] = await Promise.all([
        fetchJson<HealthWire>('GET', '/api/health'),
        fetchJson<GatewayWire>('GET', '/api/gateway').catch(() => null),
        fetchJson<ProfileWire>('GET', `/api/spaces/${encodeURIComponent(getSpace())}`).catch(() => ({} as ProfileWire)),
        fetchJson<{ roles?: TeamViewRole[] }>('GET', '/api/roles').then((d) => d.roles ?? []).catch(() => [] as TeamViewRole[]),
      ]);
      if (!alive) return;
      const team = profile.team ?? [];
      const profiles: Record<string, RoleOverallMetrics | undefined> = {};
      await Promise.all(
        [...new Set(team.map((m) => m.roleId))].map(async (roleId) => {
          profiles[roleId] = await fetchJson<RoleProfileWire>('GET', `/api/roles/${encodeURIComponent(roleId)}/profile`)
            .then((p) => p.overall)
            .catch(() => undefined);
        }),
      );
      if (!alive) return;
      const cards = buildMemberCards({
        team,
        roles: roles as TeamViewRole[],
        agentsInstalled: health.env?.agentsInstalled ?? [],
        recommendedAgentKind: health.recommendedAgentKind ?? null,
        defaultAgentKind: profile.defaultAgentKind,
        gateway: gateway ? { enabled: gateway.enabled, current: gateway.current, freeModel: gateway.freeModel } : null,
        profiles,
      });
      setState({ phase: 'ready', cards, spaceName: profile.name ?? space, teamEmpty: team.length === 0 });
    })().catch((e) => alive && setState({ phase: 'error', why: String((e as Error).message ?? e) }));
    return () => {
      alive = false;
    };
  }, [space]);

  const jumpSettings = (sec: string) => {
    setView('settings');
    // 设置页各卡住 settings-body 的滚动列里；先切目的地，落点后按锚点跳
    requestAnimationFrame(() => document.getElementById(`sec-${sec}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  return (
    <div className="team-view">
      <div className="team-head">
        <h2>班底 · {state.phase === 'ready' ? state.spaceName : '…'}</h2>
        <p className="team-sub">
          人即配置：每枚卡回答三问——他在不在 / 他会干什么 / 最近干得怎么样。读数全来自既有账（引擎实探、网关、角色库、岗级履历），这一页不产生新判据。
        </p>
      </div>

      {state.phase === 'loading' && <p className="team-hint">班底账读取中…</p>}
      {state.phase === 'error' && <p className="team-hint err">班底读不出：{state.why}（读不到不等于没人——先去高级设置查环境）</p>}

      {state.phase === 'ready' && state.teamEmpty && (
        <div className="team-empty">
          这个项目还没装班底：到「项目」发起 30 秒向导可勾选首发班底；建岗在「高级设置 → 角色库」。
          <button className="link" onClick={() => setView('projects')}>去项目 →</button>
        </div>
      )}

      {state.phase === 'ready' && state.cards.length > 0 && (
        <div className="team-grid">
          {state.cards.map((c) => (
            <article key={c.roleId} className={`member-card${c.dim ? ' dim' : ''}`}>
              <header className="member-top">
                <span className={`member-dot ${c.presence}`} aria-hidden />
                <span className="member-name">{c.display}</span>
                <span className="member-role" title={c.roleName}>{c.roleName}</span>
              </header>
              {c.note && <p className="member-note">{c.note}</p>}
              <dl className="member-lines">
                <div>
                  <dt>在不在</dt>
                  <dd>{c.presenceLine}</dd>
                </div>
                <div>
                  <dt>吃什么模型</dt>
                  <dd>{c.modelLine}</dd>
                </div>
                <div>
                  <dt>吃什么装备</dt>
                  <dd title={c.equipTitle}>{c.equipLine}</dd>
                </div>
                <div>
                  <dt>最近战绩</dt>
                  <dd>{c.trackLine}</dd>
                </div>
              </dl>
              <footer className="member-tools">
                <span className="member-tools-label">
                  <Icon name="cpu" size={11} /> 他的工具
                </span>
                <button className="link" onClick={() => jumpSettings('env')}>环境</button>
                <button className="link" onClick={() => jumpSettings('gateway')}>网关与模型</button>
                <button className="link" onClick={() => jumpSettings('roles')}>装备与岗</button>
              </footer>
            </article>
          ))}
        </div>
      )}

      <p className="team-foot">
        派活挑人在「任务」页的「由谁来干」里完成；能力条目的引用账在「能力」页——两面讲的不是一回事，互不吞并。
      </p>
    </div>
  );
}
