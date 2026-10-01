import { useEffect, useState } from 'react';
import type { RunEvent, RunRecord } from '@paneflow/shared';
import { useStore } from '../store.js';
import { api, fetchJson } from '../api.js';
import { runCostLabel } from '../cost.js';
import { needsPublicConfirm, type WikiPreviewRes } from '../wiki-sediment.js';
import { RunTimeline } from './RunTimeline.js';
import { Icon, type IconName } from './Icon.js';
import { PromptModal, type ModalRequest } from './PromptModal.js';
import { purgeRunRequest, resumeRunRequest } from '../dialogs.js';

/** 运行终章徽章：状态色 + 一枚线性图符（蓝皮书批注感，不用彩色表情符）。 */
function stateBadge(state: RunRecord['state']): { cls: string; icon: IconName | null; text: string } {
  switch (state) {
    case 'running':
      return { cls: 'working', icon: null, text: '运行中' };
    case 'queued':
      return { cls: '', icon: 'clock', text: '排队中' };
    case 'completed':
      return { cls: 'done', icon: 'check', text: '完成' };
    case 'completed-with-failures':
      return { cls: 'failed', icon: 'alert', text: '完成（有失败）' };
    case 'failed':
      return { cls: 'failed', icon: 'x', text: '失败' };
    default:
      return { cls: '', icon: null, text: '已取消' };
  }
}

/** v8-H2 产物货架的单个文件条目（<nodeId>.json 会挂上对应节点信息） */
type ArtifactFile = {
  name: string;
  size: number;
  mtime: string;
  /** v13-K1 一处清单两个来源：workspace=工作区直写（随 worktree 回收蒸发）、shelf=引擎上架副本 */
  source?: 'workspace' | 'shelf';
  /** 架侧条目挂台账指纹（引擎读原文实算）；对不上账的内容端点直接拒读 */
  sha?: string;
  nodeId?: string;
  nodeLabel?: string;
  nodeState?: string;
  unverified?: boolean;
};

function nodeDuration(r: NonNullable<ReturnType<typeof useStore.getState>['runs'][string]>, nodeId: string): number | null {
  const rec = r.nodes[nodeId];
  if (!rec?.startedAt) return null;
  const end = rec.finishedAt ? new Date(rec.finishedAt).getTime() : Date.now();
  return Math.round((end - new Date(rec.startedAt).getTime()) / 1000);
}

function useBrowserNotify(): [boolean, () => void] {
  const [on, setOn] = useState(() => localStorage.getItem('pf-notify-browser') === '1');
  const enable = () => {
    if (!on && 'Notification' in window) {
      void Notification.requestPermission().then((perm) => {
        if (perm === 'granted') {
          localStorage.setItem('pf-notify-browser', '1');
          setOn(true);
        }
      });
    } else {
      localStorage.setItem('pf-notify-browser', on ? '0' : '1');
      setOn(!on);
    }
  };
  return [on, enable];
}

/** Global browser notifications on blocked/completed/failed (deduped). */
export function useRunNotifications(): void {
  const runs = useStore((s) => s.runs);
  useEffect(() => {
    if (localStorage.getItem('pf-notify-browser') !== '1' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    for (const r of Object.values(runs)) {
      const blocked = Object.values(r.nodes).filter((n) => n.state === 'blocked');
      const key = (ev: string) => `pf-ntf-${r.runId}-${ev}`;
      if (blocked.length && !sessionStorage.getItem(key('blocked'))) {
        sessionStorage.setItem(key('blocked'), '1');
        new Notification(`PaneFlow ⛔ 等待审批`, { body: `${r.dagName}（${r.runId}）：${blocked.map((n) => n.nodeId).join('、')}` });
      }
      if (['completed', 'failed', 'completed-with-failures'].includes(r.state) && !sessionStorage.getItem(key(r.state))) {
        sessionStorage.setItem(key(r.state), '1');
        new Notification(`PaneFlow ${r.state === 'completed' ? '✅ 已完成' : r.state === 'completed-with-failures' ? '⚠ 完成（有失败）' : '❌ 失败'}`, { body: `${r.dagName}（${r.runId}）` });
      }
    }
  }, [runs]);
}

/** v7-A2 归档面板：反归档回主列表 / 真删除（v8-H2：可选一并清理本 run 产物，默认保留）。 */
function ArchivedPanel() {
  const log = useStore((s) => s.log);
  const [archived, setArchived] = useState<RunRecord[] | null>(null);
  const [modal, setModal] = useState<ModalRequest | null>(null);
  /** 反归档按行读数：这一枚是图标按钮，点了没字就是「没点上」，人会对着同一行再按一次 */
  const [restoring, setRestoring] = useState<Record<string, boolean>>({});

  const reload = () => {
    void fetchJson<{ runs: RunRecord[] }>('GET', '/api/runs?archived=1')
      .then((d) => setArchived(d.runs))
      .catch((e: Error) => {
        log('error', `读取归档列表失败：${e.message}`);
        setArchived([]);
      });
  };
  useEffect(reload, []);

  const unarchive = async (runId: string) => {
    setRestoring((c) => ({ ...c, [runId]: true }));
    try {
      const d = await fetchJson<{ restored: boolean; run: RunRecord }>('POST', `/api/runs/${encodeURIComponent(runId)}/unarchive`);
      useStore.setState((s) => ({ runs: { ...s.runs, [d.run.runId]: d.run } }));
      setArchived((cur) => (cur ?? []).filter((r) => r.runId !== runId));
      log('info', `已恢复 ${runId} 到主列表`);
    } catch (e) {
      setRestoring((c) => {
        const next = { ...c };
        delete next[runId];
        return next;
      });
      log('error', `反归档失败：${(e as Error).message}`);
    }
  };

  // 原生 confirm 归位 D3 模态（v14 better-ui）：两次连排问句并成一次，产物清理成默认不勾的勾选框。
  // 报错不再只落 toast——onSubmit 抛出的 server 原文由模态显示在框内、窗不关，人可以改勾再试或 Esc。
  const purge = (runId: string) =>
    setModal(
      purgeRunRequest(runId, async (alsoArtifacts) => {
        const d = await fetchJson<{ deleted: boolean; purgedArtifacts: number }>(
          'DELETE',
          `/api/runs/${encodeURIComponent(runId)}/archive${alsoArtifacts ? '?purgeArtifacts=1' : ''}`,
        );
        if (d.purgedArtifacts) log('info', `已连带清理 ${d.purgedArtifacts} 个产物文件`);
        setArchived((cur) => (cur ?? []).filter((r) => r.runId !== runId));
        log('info', `已真删除 ${runId}`);
      }),
    );

  if (archived === null) return <div className="runs-empty">归档加载中…</div>;
  if (archived.length === 0) return <div className="runs-empty">没有归档记录。运行卡片上按「归档」可归档到这里。</div>;
  return (
    <div>
      {archived.map((r) => (
        <div key={r.runId} className="run-card" style={{ opacity: 0.85 }}>
          <div className="run-card-head">
            <b>#{r.runId}</b> <span className="run-card-title">{r.dagName}</span>
            <span className={`badge ${r.state === 'completed' ? 'done' : r.state === 'failed' || r.state === 'completed-with-failures' ? 'failed' : ''}`}>
              {r.state === 'completed' ? '完成' : r.state === 'completed-with-failures' ? '完成（有失败）' : r.state === 'failed' ? '失败' : r.state}
            </span>
            <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>{r.startedAt.slice(0, 16).replace('T', ' ')}</span>
            <div className="run-card-ops">
              <button title="导出完整记录 JSON" aria-label="导出完整记录 JSON" onClick={() => {
                const a = document.createElement('a');
                a.href = `/api/runs/${encodeURIComponent(r.runId)}/export`;
                a.download = `${r.runId}.json`;
                a.click();
              }}>
                <Icon name="download" />
              </button>
              <button
                disabled={restoring[r.runId]}
                title={restoring[r.runId] ? '恢复指令发送中…' : '恢复到主列表（反归档）'}
                onClick={() => void unarchive(r.runId)}
              >
                {restoring[r.runId] ? '恢复中…' : <Icon name="undo" />}
              </button>
              <button className="danger" title="真删除（不可恢复；可选一并清理本 run 产物，默认保留）" onClick={() => purge(r.runId)}>
                <Icon name="trash" />
              </button>
            </div>
          </div>
        </div>
      ))}
      {modal && <PromptModal req={modal} onClose={() => setModal(null)} />}
    </div>
  );
}

/** v9-K1/K3 + v11-C5：点赞沉淀弹层——先 GET /api/wiki/preview（零网络零 push）看将推草稿，
 * 门不过亮红因并禁按钮；public 仓用「我确认公开」勾选替代旧 window.confirm 二次确认舞。 */
function WikiPublishModal({ run, preview, onClose }: { run: RunRecord; preview: WikiPreviewRes; onClose: () => void }) {
  const log = useStore((s) => s.log);
  const [publicChecked, setPublicChecked] = useState(false);
  const [serverPublic, setServerPublic] = useState(false); // preview 没缓存可见性时的兜底：publish 409 现场告知
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const gateOk = preview.gate.ok;
  const publicWarn = needsPublicConfirm(preview, serverPublic);
  const canPush = gateOk && (!publicWarn || publicChecked) && !busy;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const push = async () => {
    setBusy(true);
    setErr(null);
    try {
      const d = await fetchJson<{ url: string; file: string }>('POST', '/api/wiki/publish', {
        runId: run.runId,
        kind: preview.kind,
        ...(publicWarn ? { confirm: true } : {}),
      });
      log('info', `✅ 已沉淀到仓库 llm-wiki/ 目录：${d.url}`);
      useStore.getState().notifyWikiPublished(); // 设置页沉淀卡据此即时重拉状态
      onClose();
    } catch (e) {
      const msg = (e as Error).message;
      // 可见性此前没缓存过：409 回来就在弹层内升级为勾选，不换窗口、不重走三段
      if (msg.includes('对全世界可读')) setServerPublic(true);
      else setErr(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal modal-wiki" role="dialog" aria-modal="true" aria-label="沉淀预览" onClick={(e) => e.stopPropagation()}>
        <h2>沉淀预览 · {run.dagName}</h2>
        <div className="wiki-pv-meta">
          <span>
            目标仓 <b>{preview.repo || '（未配置）'}</b>
          </span>
          <span>
            落点 <b>{preview.page?.file ?? '—'}</b>
          </span>
          <span className={`gate-flag ${gateOk ? 'ok' : 'bad'}`}>
            <Icon name={gateOk ? 'check' : 'pause'} size={11} />
            {gateOk ? '已过沉淀门' : '门不过'}
          </span>
        </div>
        {preview.kind === 'counterexample' && (
          <p className="wiki-pv-counter">
            ⚠ 反面教材侧门：这单带失败收口，将以低置信（confidence: low + 页首 ⚠ 警示 + index 条目 ⚠ 标记）入仓——
            只沉淀教训供后来人避坑，结论与做法不可照抄。
          </p>
        )}
        {!gateOk && <p className="wiki-pv-gate">{preview.gate.reason ?? '沉淀门未通过'}</p>}
        {preview.page && <pre className="wiki-pv-md">{preview.page.markdown}</pre>}
        {publicWarn && (
          <label className="wiki-pv-confirm">
            <input type="checkbox" checked={publicChecked} disabled={busy} onChange={(e) => setPublicChecked(e.target.checked)} />
            <span>
              仓库 {preview.repo} 是公开的，沉淀页将<b>对全世界可读</b>——我确认公开
            </span>
          </label>
        )}
        {err && <p className="wiki-pv-gate">推送失败：{err}</p>}
        <div className="close-row">
          <button onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="primary"
            disabled={!canPush}
            title={!gateOk ? '沉淀门不过，推不动' : publicWarn && !publicChecked ? '先勾选「我确认公开」' : '把这份草稿推到仓库 llm-wiki/ 目录'}
            onClick={() => void push()}
          >
            {busy ? '推送中…' : '推到仓库'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 运行中心（B9 第一版）：全部空间的运行总览、进度、操作。 */
export function RunsCenter() {
  const runs = useStore((s) => s.runs);
  const [notifyOn, toggleNotify] = useBrowserNotify();
  useRunNotifications();
  const openRun = useStore((s) => s.openRun);
  const setView = useStore((s) => s.setView);
  const log = useStore((s) => s.log);
  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const [modal, setModal] = useState<ModalRequest | null>(null);

  // 时间线：运行中的记录随 WS 实时到（读 store），历史记录按需拉一次
  const [openTl, setOpenTl] = useState<string | null>(null);
  const [fetched, setFetched] = useState<Record<string, RunEvent[]>>({});
  const [loadingTl, setLoadingTl] = useState<string | null>(null);

  // v8-H2 产物货架：展开时拉一次文件列表，查看按需拉单文件内容
  const [openArts, setOpenArts] = useState<string | null>(null);
  const [artLists, setArtLists] = useState<Record<string, { dir: string; exists: boolean; files: ArtifactFile[] }>>({});
  const [artView, setArtView] = useState<Record<string, string>>({});

  /**
   * 写面那一刀的在飞读数，按 runId 记（这几枚按钮点下去都是真 POST）。
   * 'stop' = 指令还在路上，'stop-done' = server 已收但这一单还没落终态——
   * 两态分开是因为「发停止指令」成功不等于「已停」：把读数在 POST 回来时抹掉，
   * 卡片还挂着「运行中」，按钮回到原样就是请人再按一次。
   */
  const [runOp, setRunOp] = useState<Record<string, 'stop' | 'stop-done' | 'archive'>>({});
  const setRunOpFor = (runId: string, op: 'stop' | 'stop-done' | 'archive' | null) =>
    setRunOp((c) => {
      const next = { ...c };
      if (op === null) delete next[runId];
      else next[runId] = op;
      return next;
    });

  const toggleArtifacts = async (runId: string) => {
    if (openArts === runId) {
      setOpenArts(null);
      return;
    }
    setOpenArts(runId);
    if (artLists[runId]) return;
    try {
      const d = await fetchJson<{ dir: string; exists: boolean; files: ArtifactFile[] }>('GET', `/api/runs/${encodeURIComponent(runId)}/artifacts`);
      setArtLists((c) => ({ ...c, [runId]: d }));
    } catch (e) {
      log('error', `读取产物列表失败：${(e as Error).message}`);
    }
  };

  const viewArtifact = async (runId: string, f: ArtifactFile) => {
    const key = `${runId}:${f.name}`;
    if (artView[key]) {
      setArtView((c) => {
        const next = { ...c };
        delete next[key];
        return next;
      });
      return;
    }
    try {
      const d = await fetchJson<{ content: string; truncated: boolean }>(
        'GET',
        // v13-K1：架上条目必须带 src=shelf 才读得到（工作区侧同格路径没有这份东西），两侧不混为一谈
        `/api/runs/${encodeURIComponent(runId)}/artifacts/file?path=${encodeURIComponent(f.name)}&src=${f.source ?? 'workspace'}`,
      );
      setArtView((c) => ({ ...c, [key]: d.content + (d.truncated ? '\n…（内容过大，已截断——用「下载」看全文）' : '') }));
    } catch (e) {
      setArtView((c) => ({ ...c, [key]: `（无法内联预览：${(e as Error).message}——试「下载」）` }));
    }
  };

  const toggleTimeline = async (runId: string, liveHasEvents: boolean) => {
    if (openTl === runId) {
      setOpenTl(null);
      return;
    }
    setOpenTl(runId);
    if (liveHasEvents || fetched[runId]) return;
    setLoadingTl(runId);
    try {
      const r = await api.runEvents(runId);
      setFetched((c) => ({ ...c, [runId]: r.events }));
    } catch (e) {
      log('error', `读取事件时间线失败：${(e as Error).message}`);
      setFetched((c) => ({ ...c, [runId]: [] }));
    } finally {
      setLoadingTl((prev) => (prev === runId ? null : prev));
    }
  };

  const list = Object.values(runs).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const blockedCount = list.filter((r) => r.state === 'running' && Object.values(r.nodes).some((n) => n.state === 'blocked')).length;
  const runningCount = list.filter((r) => r.state === 'running').length;
  const queuedCount = list.filter((r) => r.state === 'queued').length;

  const stop = async (runId: string) => {
    setRunOpFor(runId, 'stop');
    try {
      await api.stopRun(runId);
      log('warn', `已发送停止指令：${runId}`);
      setRunOpFor(runId, 'stop-done');
    } catch (e) {
      setRunOpFor(runId, null);
      log('error', `停止失败：${(e as Error).message}`);
    }
  };

  // v7-A2 归档：移出主列表、记录保留。成功即把这张卡从 store 里摘掉，所以在飞读数只盖住 POST 那一段
  const archive = async (runId: string) => {
    setRunOpFor(runId, 'archive');
    try {
      await fetchJson<{ archived: boolean }>('POST', `/api/runs/${encodeURIComponent(runId)}/archive`);
      useStore.setState((s) => {
        const runs = { ...s.runs };
        delete runs[runId];
        return { ...s, runs };
      });
    } catch (e) {
      setRunOpFor(runId, null);
      log('error', `归档失败：${(e as Error).message}`);
    }
  };

  // v7-A5 断点续跑：以源 run 已应用的图重启，done 节点（含 fanout 克隆）整体继承不重跑。
  // 「继承哪几格」的读数住在 dialogs.resumeRunRequest（纯函数，web 无渲染测试，所以文案与判据都在那里可断言）。
  const resume = (r: RunRecord) =>
    setModal(
      resumeRunRequest(r, async () => {
        const d = await api.resumeRun(r);
        const done = Object.values(r.nodes).filter((n) => n.state === 'done').length;
        log('info', `断点续跑已启动：新 run ${d.runId} 继承 ${done} 个已完成节点`);
      }),
    );

  // v11-C5：推前预览弹层替代旧「409→window.confirm→重发」三段舞——先拉 preview（零网络零 push），
  // 草稿看过门过过再推；failed / completed-with-failures 单服务端自动预选反面教材侧门。
  const [wikiPreview, setWikiPreview] = useState<{ run: RunRecord; loading: boolean; res: WikiPreviewRes | null } | null>(null);
  const openWikiPreview = async (r: RunRecord) => {
    setWikiPreview({ run: r, loading: true, res: null });
    try {
      const p = await fetchJson<WikiPreviewRes>('GET', `/api/wiki/preview?runId=${encodeURIComponent(r.runId)}`);
      setWikiPreview((cur) => (cur && cur.run.runId === r.runId ? { run: r, loading: false, res: p } : cur));
    } catch (e) {
      setWikiPreview(null);
      log('error', `拉取沉淀预览失败：${(e as Error).message}`);
    }
  };

  const progress = (r: (typeof list)[number]): { done: number; total: number } => {
    const all = Object.values(r.nodes);
    const done = all.filter((n) => ['done', 'failed', 'skipped', 'cancelled'].includes(n.state)).length;
    return { done, total: all.length };
  };

  return (
    <div className="runs-center">
      <div className="runs-status">
        <button className={tab === 'active' ? 'active' : ''} onClick={() => setTab('active')}>全部运行</button>
        <button className={tab === 'archived' ? 'active' : ''} title="已归档记录：可恢复或真删除" onClick={() => setTab('archived')}>
          <Icon name="box" size={12} /> 已归档
        </button>
        <span className="runs-status-stats"><b>{runningCount}</b> 运行中</span>
        {queuedCount > 0 && <span><b>{queuedCount}</b> 排队中</span>}
        <span className={blockedCount ? 'runs-alert' : ''}><b>{blockedCount}</b> 待审批</span>
        <span style={{ color: 'var(--text-dim)' }}>共 {list.length} 条历史</span>
        <button
          onClick={toggleNotify}
          title={notifyOn ? '浏览器通知已开启（点击关闭）' : '开启浏览器通知：等待审批/完成/失败时提醒'}
          style={notifyOn ? { borderColor: 'var(--ok)', color: 'var(--ok)' } : undefined}
        >
          <Icon name="bell" size={13} />
        </button>
      </div>
      {tab === 'archived' && <ArchivedPanel />}
      {tab === 'active' && (
        <>
      {list.length === 0 && <div className="runs-empty">还没有运行记录。去「编」视图搭建流水线并运行。</div>}
      {list.map((r) => {
        const p = progress(r);
        const blockedNodes = Object.values(r.nodes).filter((n) => n.state === 'blocked');
        const elapsed = ((new Date(r.finishedAt ?? Date.now()).getTime() - new Date(r.startedAt).getTime()) / 1000).toFixed(0);
        const liveEvents = r.events;
        const events = liveEvents && liveEvents.length ? liveEvents : fetched[r.runId];
        const open = openTl === r.runId;
        const eventCount = events?.length ?? liveEvents?.length ?? 0;
        const badge = stateBadge(r.state);
        // v13-K2 打回账：引擎把每一笔否决落在**被拒方**节点上，这里只做加法和照抄，
        // 不判「该不该打回」——判据在回边条件与封顶那一侧（server）。
        const reworked = Object.values(r.nodes)
          .map((n) => ({ id: n.nodeId, rs: n.rejections ?? [] }))
          .filter((x) => x.rs.length > 0);
        const reworkTotal = reworked.reduce((s, x) => s + x.rs.length, 0);
        const op = runOp[r.runId];
        return (
          <div key={r.runId} className={`run-card state-${r.state}`}>
            <div className="run-card-head">
              <b>{r.issueId ? `#${r.issueId}` : `#${r.runId}`}</b> <span className="run-card-title">{r.dagName}</span>
              <span className={`badge ${badge.cls}`}>
                {badge.icon && <Icon name={badge.icon} size={11} />}
                {badge.text}
              </span>
              <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>{r.state === 'queued' ? `已等 ${elapsed}s` : `${elapsed}s`}</span>
              {runCostLabel(r) && (
                <span className="run-cost-chip" title="成本账：时长/重试/tokens（unknown = agent 未自报，不估算）">{runCostLabel(r)}</span>
              )}
              {Object.values(r.nodes).some((n) => n.unverified) && (
                <span className="run-cost-chip" style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }} title="部分节点结果文件缺失，产物取自终端尾部兜底（未经文件验证，结论可信度打折）">
                  <Icon name="alert" size={11} /> 未验证产物
                </span>
              )}
              {reworkTotal > 0 && (
                <span
                  className="run-cost-chip"
                  style={{ borderColor: 'var(--err)', color: 'var(--err)' }}
                  title={[
                    `打回账：审查岗经否决回边把货退回重做过 ${reworkTotal} 次（不是引擎重试——重试是超时/报错自己再跑，打回是这一格的件被否了）`,
                    ...reworked.map((x) => {
                      const last = x.rs[x.rs.length - 1];
                      const capped = x.rs.some((rj) => rj.action === 'capped');
                      return `· ${x.id} 被打回 ${x.rs.length} 次${last ? `（${last.reviewer} 拒 · ${capped ? '上限已达，未再重跑' : '已重跑'}）` : ''}${last?.reason ? `：${last.reason}` : ''}`;
                    }),
                  ].join('\n')}
                >
                  <Icon name="undo" size={11} /> 打回 {reworkTotal} 次
                </span>
              )}
              {r.contract && (
                <span
                  className="run-cost-chip"
                  title={[
                    `这单按以下约定在干（${r.contract.source === 'input' ? '需求自带' : '契约门谈定'}${r.contract.template ? `・骨架 ${r.contract.template}` : ''}${r.contract.confirmedAt ? `・${r.contract.confirmedAt.slice(0, 19).replace('T', ' ')} 已确认` : '・待确认'}）：`,
                    ...r.contract.assertions.map((a) => `${a.id}: ${a.assertion}`),
                    ...(r.contract.scopeNotes ? [`边界：${r.contract.scopeNotes}`] : []),
                  ].join('\n')}
                >
                  <Icon name="doc" size={11} /> 契约 {r.contract.assertions.length} 条{r.contract.source === 'generated' && !r.contract.confirmedAt ? '·待确认' : ''}
                </span>
              )}
              {r.prUrl && (
                <a
                  className="run-cost-chip"
                  href={r.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ borderColor: 'var(--ok, var(--accent))', color: 'var(--ok, var(--accent))', textDecoration: 'none' }}
                  title={`交付出口：${r.prUrl}（人类可 review 的东西已经出网）`}
                >
                  <Icon name="pr" size={11} /> PR
                </a>
              )}
              {/* v11-C3b 回链的 run→页面：C3a 读回真注入了才显（留痕只计进了 prompt 的页） */}
              {r.wikiReadback && r.wikiReadback.nodes.length > 0 && (
                <span
                  className="run-cost-chip"
                  title={[
                    `本单起跑时读回了 ${r.wikiReadback.repo} 的沉淀页（复利读端留痕）：`,
                    ...[...new Set(r.wikiReadback.nodes.flatMap((n) => n.pages.map((p) => `${p.title}（${p.file}）`)))],
                  ].join('\n')}
                >
                  <Icon name="book" size={11} /> 读了 {[...new Set(r.wikiReadback.nodes.flatMap((n) => n.pages.map((p) => p.file)))].length} 页沉淀
                </span>
              )}
              <div className="run-card-ops">
                <button
                  className={open ? 'active' : ''}
                  title={`事件时间线：谁在何时做了什么${eventCount ? `（${eventCount} 条）` : ''}`}
                  onClick={() => void toggleTimeline(r.runId, !!liveEvents?.length)}
                >
                  <Icon name="clock" size={12} />{eventCount ? ` ${eventCount}` : ''}
                </button>
                <button
                  className={openArts === r.runId ? 'active' : ''}
                  title={artLists[r.runId] ? `产物货架：这单落下了 ${artLists[r.runId]!.files.length} 个文件（可点开/下载）` : '产物货架：这单落下的交付文件（点开看清单）'}
                  onClick={() => void toggleArtifacts(r.runId)}
                >
                  <Icon name="shelf" size={12} />{artLists[r.runId] ? ` ${artLists[r.runId]!.files.length}` : ''}
                </button>
                {['completed', 'failed', 'completed-with-failures'].includes(r.state) && (
                  <button
                    disabled={wikiPreview?.run.runId === r.runId && wikiPreview.loading}
                    title={
                      r.state === 'completed'
                        ? '点赞沉淀：先看这单沉淀页草稿（契约/验收结论/经验），确认后推到仓库 llm-wiki/ 目录（宁缺毋滥，手动触发）'
                        : '沉淀教训：这单带失败收口，走反面教材侧门（低置信 ⚠ 页，只供避坑）；推送前同样先看草稿'
                    }
                    onClick={() => void openWikiPreview(r)}
                  >
                    {wikiPreview?.run.runId === r.runId && wikiPreview.loading ? (
                      '预览中…'
                    ) : (
                      <>
                        <Icon name="bookmark" size={12} /> {r.state === 'completed' ? '沉淀' : '沉淀教训'}
                      </>
                    )}
                  </button>
                )}
                <button title="导出完整记录 JSON" aria-label="导出完整记录 JSON" onClick={() => {
                  const a = document.createElement('a');
                  a.href = `/api/runs/${r.runId}/export`;
                  a.download = `${r.runId}.json`;
                  a.click();
                }}>
                  <Icon name="download" size={12} />
                </button>
                {!['running', 'queued'].includes(r.state) && (
                  <button
                    disabled={op === 'archive'}
                    title={op === 'archive' ? '归档指令发送中…' : '归档（移出主列表，记录保留）'}
                    onClick={() => void archive(r.runId)}
                  >
                    {op === 'archive' ? '归档中…' : <Icon name="box" size={12} />}
                  </button>
                )}
                {r.state === 'failed' && (
                  <button title="从断点续跑（已完成节点直接继承，失败/未跑节点重执行）" aria-label="从断点续跑（已完成节点直接继承，失败/未跑节点重执行）" onClick={() => resume(r)}>
                    <Icon name="resume" size={12} />
                  </button>
                )}
                <button title="在画布中打开" aria-label="在画布中打开" onClick={() => { openRun(r.runId); setView('orchestrate'); }}>
                  <Icon name="external" size={12} />
                </button>
                {r.state === 'running' && (
                  <button
                    className="danger"
                    disabled={op !== undefined}
                    title={
                      op === 'stop'
                        ? '停止指令发送中…'
                        : op === 'stop-done'
                          ? '停止指令已发出，等这一单在节点边界收口（再点一下不会更快）'
                          : '停止'
                    }
                    onClick={() => void stop(r.runId)}
                  >
                    {op ? (op === 'stop' ? '停止中…' : '等待收口…') : <Icon name="stop" size={12} />}
                  </button>
                )}
                {r.state === 'queued' && (
                  <button
                    className="danger"
                    disabled={op !== undefined}
                    title={
                      op === 'stop'
                        ? '撤回排队指令发送中…'
                        : op === 'stop-done'
                          ? '已撤回：这一单不会开跑，等列表把它收成「已取消」'
                          : '取消排队（尚未开跑，撤回即终态）'
                    }
                    onClick={() => void stop(r.runId)}
                  >
                    {op ? (op === 'stop' ? '取消中…' : '已撤回…') : <Icon name="x" size={12} />}
                  </button>
                )}
              </div>
            </div>
            <div className="run-progress">
              <div className="run-progress-bar">
                <div
                  className="run-progress-fill"
                  style={{ width: `${p.total ? (p.done / p.total) * 100 : 0}%`, background: r.state === 'failed' ? 'var(--err)' : r.state === 'completed-with-failures' ? 'var(--warn)' : 'var(--ok)' }}
                />
              </div>
              <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>{p.done}/{p.total} 节点</span>
              {blockedNodes.length > 0 && (
                <span className="badge blocked">
                  <Icon name="pause" size={11} /> {blockedNodes.map((n) => n.nodeId).join('、')} 等审批
                </span>
              )}
              {r.spaceId && <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>项目 {r.spaceId}</span>}
            </div>
            {open && (
              <RunTimeline
                compact
                events={events}
                startedAt={r.startedAt}
                running={r.state === 'running'}
                loading={loadingTl === r.runId}
                emptyHint="这条运行没有事件记录（可能是埋点上线前的历史运行）。"
              />
            )}
            {openArts === r.runId && (
              <div className="artifact-shelf">
                {!artLists[r.runId] && <div className="artifact-row dim">产物列表加载中…</div>}
                {artLists[r.runId]?.exists === false && (
                  <div className="artifact-row dim">这单还没有产物文件（期望位置：{artLists[r.runId]!.dir}）。</div>
                )}
                {artLists[r.runId]?.files.map((f) => {
                  const viewKey = `${r.runId}:${f.name}`;
                  return (
                    <div key={f.name} className="artifact-item">
                      <div className="artifact-row">
                        <b>{f.name}</b>
                        {f.nodeLabel && (
                          <span className="artifact-chip">
                            {f.nodeLabel}
                            {f.nodeState ? `·${f.nodeState}` : ''}
                          </span>
                        )}
                        {f.unverified && (
                          <span className="artifact-chip warn" title="该节点产物取自终端尾部兜底，未经文件验证">
                            <Icon name="alert" size={10} /> 未验证
                          </span>
                        )}
                        {f.source === 'shelf' && (
                          <span className="artifact-chip" title={`引擎上架的副本，工作区被回收后仍可取证${f.sha ? ` · 台账指纹 ${f.sha}` : ''}`}>
                            <Icon name="shelf" size={10} /> 架上{f.sha ? `·${f.sha}` : ''}
                          </span>
                        )}
                        <span className="dim">
                          {(f.size / 1024).toFixed(1)} KB · {f.mtime.slice(0, 19).replace('T', ' ')}
                        </span>
                        <button onClick={() => void viewArtifact(r.runId, f)}>{artView[viewKey] ? '收起' : '查看'}</button>
                        <a
                          className="artifact-dl"
                          href={`/api/runs/${encodeURIComponent(r.runId)}/artifacts/file?path=${encodeURIComponent(f.name)}&src=${f.source ?? 'workspace'}&raw=1`}
                          download={f.name}
                          title="下载原文件"
                        >
                          <Icon name="download" size={12} />
                        </a>
                      </div>
                      {artView[viewKey] && <pre className="artifact-content">{artView[viewKey]}</pre>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
        </>
      )}
      {wikiPreview && !wikiPreview.loading && wikiPreview.res && (
        <WikiPublishModal run={wikiPreview.run} preview={wikiPreview.res} onClose={() => setWikiPreview(null)} />
      )}
      {modal && <PromptModal req={modal} onClose={() => setModal(null)} />}
    </div>
  );
}
