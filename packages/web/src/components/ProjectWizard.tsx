import { useEffect, useMemo, useState } from 'react';
import type { EnvProbeItem } from '../api.js';
import { api, fetchJson } from '../api.js';
import { useActionNote } from '../action-note.js';
import type { ProjectLite } from '../project-cards.js';
import {
  createSpaceFailNote,
  idCollisionNote,
  probeBodyFailNote,
  probeFailNote,
  registerFailNote,
  registerZeroNote,
  spacesReadNote,
  teamSeedFailNote,
  teamSeedOkNote,
} from '../project-wizard.js';
import { scanRegisterOutcome } from '../write-outcome.js';
import { useStore } from '../store.js';
import { Icon } from './Icon.js';

/**
 * 项目新建向导（v17-W）：新用户从零到能跑任务的一条线——
 *   ① 起名 + 给根目录 → ② 创建并扫描，勾选要登记的能力（可选装首发班底）→ 完成。
 *   扫描登记走既有的只读 envProbe / 事务性 envRegister（rootCwd 由 server 在登记现场写进档案），
 *   本组件不 stat 任何盘上路径，判据全在 server。
 *
 * v19 步骤二十三：这一片按的是**四发**请求（建档案 / 只读扫描 / 批量登记 / 装填班底），
 * 读数也就按动词分格各说一句——从前它们合成一句「创建/扫描没走通」，而档案其实已经落笔，
 * 于是「建成了」被说成「没走通」，人再按一次又往 server 打一发创建；收尾那一下失败还连窗一起关掉，
 * 勾选项跟着人没。重试也只重发**没成那一发**（`registered` / `teamSeeded` 两位记着哪发已经成了）。
 * 走出去只剩两条路：每一发都拿到正读数，或者人自己按「知道了」/「以后再说」——同一发 200 里 server
 * 交回的 `warnings`（只披露不登记）与 `registered: 0`（一项没落）都先把窗按住：拿关窗抹掉它们，
 * 就是替人把「没成」读成「登记好了」。
 * 诚实边界：第②步「创建项目」落定后中途取消，会留下一个空档案——无害，可在项目页补配或忽略。
 */

const KIND_LABELS: Record<string, string> = {
  repo: '📦 仓库',
  doc: '📄 约定文档',
  skill: '📚 技能',
  rule: '📏 规则',
};

const KIND_HINTS: Record<string, string> = {
  repo: 'Agent 干活的代码仓，交付家规按它拉分支',
  doc: '会作为约定注入给该项目的 Agent',
  skill: '作业手册，运行时自动注入',
  rule: '硬约束（可带仓库/目录作用域）',
};

/** 项目 ID 只能字母/数字/-/_（server 同一把尺，提前给是为了让「自动起 id」不白打） */
function slugify(name: string): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 32);
}

/** 收尾那两发的读数，按动词分格：登记（成了几项/哪些只披露/没成）与班底（成了/没成）各说各的 */
interface FinishReadings {
  regOk: string | null;
  regWarn: string[];
  regFail: string | null;
  teamOk: string | null;
  teamFail: string | null;
}
const EMPTY_READINGS: FinishReadings = { regOk: null, regWarn: [], regFail: null, teamOk: null, teamFail: null };

export function ProjectWizard() {
  const log = useStore((s) => s.log);
  const setPwOpen = useStore((s) => s.setPwOpen);
  const switchSpace = useStore((s) => s.switchSpace);
  const setCwd = useStore((s) => s.setCwd);
  const setView = useStore((s) => s.setView);

  const [step, setStep] = useState<0 | 1>(0);
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');
  const [creating, setCreating] = useState(false);
  /** 空名字/空路径不用这里说：两项填齐前那一按本来就是 disabled；这里只报真能撞到的那种填法 */
  const dirPre = useActionNote(dir.trim());
  /** 那一按成没成是过去的事实：不带 ctx，后续改名字/改目录不洗它 */
  const createNote = useActionNote('');

  // 第②步的读数（项目档案已建成才有）
  const [spaceId, setSpaceId] = useState('');
  const [items, setItems] = useState<EnvProbeItem[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [seedTeam, setSeedTeam] = useState(true);
  const [finishing, setFinishing] = useState(false);
  const [probeFail, setProbeFail] = useState<string | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [fin, setFin] = useState<FinishReadings>(EMPTY_READINGS);
  const [registered, setRegistered] = useState(false);
  const [teamSeeded, setTeamSeeded] = useState(false);

  // 在册项目清单：只为「同 ID 会把已有档案改名」这一句预检取材（判据在 server 的 upsert 语义里）
  const [spaces, setSpaces] = useState<ProjectLite[] | null>(null);
  const [spacesFail, setSpacesFail] = useState<string | null>(null);

  const autoId = useMemo(() => slugify(name), [name]);
  /** 中文名单 slugify 出来是空串，退一枚随机 id——**整个向导期内定住**：
   *  第一发真落了笔而回执读不到时，重试打的是同一枚 id，不会多落一枚孤儿档案 */
  const fallbackId = useMemo(() => `proj-${Date.now().toString(36)}`, []);
  const finalId = autoId || fallbackId;

  useEffect(() => {
    let live = true;
    fetchJson<{ spaces?: ProjectLite[] }>('GET', '/api/spaces')
      .then((r) => {
        if (!live) return;
        setSpaces(r.spaces ?? []);
        setSpacesFail(null);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setSpaces(null);
        setSpacesFail(spacesReadNote(e));
      });
    return () => {
      live = false;
    };
  }, []);

  const close = () => setPwOpen(false);
  const collision = idCollisionNote(spaces, finalId, name.trim());

  /** 只读扫描这一发（第①步之后与「再扫一次」共用；它不碰档案，所以重试不双建） */
  const runProbe = async (target: string) => {
    setProbeBusy(true);
    try {
      const r = await api.envProbe(target);
      const found = r.items ?? [];
      setItems(found);
      setSelected(new Set(found.map((_, i) => i)));
      // server 对读不动的目录回的是 200 + `error`：拿它画「没探出东西」就是充实测结论
      setProbeFail(r.error?.trim() ? probeBodyFailNote(r.error.trim()) : null);
    } catch (e) {
      setItems([]);
      setSelected(new Set());
      setProbeFail(probeFailNote(e));
    } finally {
      setProbeBusy(false);
    }
  };

  /** 根目录这一格的尺：第①步那一按与第②步的重扫共用同一句，改对了句子自己跟着撤 */
  const rejectNonAbsDir = () => {
    dirPre.clearNote();
    if (dir.trim().startsWith('/')) return false;
    dirPre.notePrecheck('根目录要是绝对路径（以 / 开头）');
    return true;
  };

  /** 第②步的「重扫」：只重问扫描这一发——项目档案那一发已经在第①步落了笔，不该跟着重试再打一发 */
  const retryProbe = () => {
    if (rejectNonAbsDir()) return;
    void runProbe(dir.trim());
  };

  /** 第①步 → 第②步：先建档案（成了就把人带到第二步，扫描那一发单独报） */
  const createAndScan = async () => {
    createNote.clearNote();
    if (rejectNonAbsDir()) return;
    setCreating(true);
    try {
      await fetchJson<unknown>('POST', '/api/spaces', { id: finalId, name: name.trim() });
      setSpaceId(finalId);
      setStep(1);
      await runProbe(dir.trim());
    } catch (e) {
      // 这一发没成：名字与路径一个字不清，人就原地改完再按
      createNote.noteResult(createSpaceFailNote(e));
    } finally {
      setCreating(false);
    }
  };

  /** 切过去开用：只有登记与班底两发都过了、且没有「只披露不登记」项要人读时才走 */
  const leaveProject = (summary: string) => {
    log('info', summary);
    switchSpace(spaceId);
    setCwd(dir.trim());
    void api
      .listRuns()
      .then((x) => useStore.getState().mergeRuns(x.runs))
      .catch(() => undefined);
    setPwOpen(false);
    setView('tasks');
  };

  /** 完成：勾选项批量登记（rootCwd 由 server 顺带写入）＋ 可选装首发班底 */
  const finish = async () => {
    setFinishing(true);
    setFin((p) => ({ ...p, regFail: null, teamFail: null }));
    let regOk = fin.regOk;
    let regWarn = fin.regWarn;
    let teamOk = fin.teamOk;
    /** 这一发回 200 却报 0 项：占住红色那一格，并拦下走出去（它借的不是成功的形状） */
    let regZero: string | null = null;

    if (!registered) {
      try {
        const r = await api.envRegister(dir.trim(), spaceId, Array.from(selected));
        const outcome = scanRegisterOutcome(r, spaceId);
        regOk = outcome.ok;
        regWarn = outcome.warn;
        regZero = !outcome.ok && selected.size > 0 ? registerZeroNote(selected.size) : null;
        setFin((p) => ({ ...p, regOk, regWarn, regFail: regZero }));
        setRegistered(true);
      } catch (e) {
        const note = registerFailNote(e);
        setFin((p) => ({ ...p, regFail: note }));
        log('error', `${note}（项目档案已建好，可到「项目 → 编辑档案」手工补）`);
        setFinishing(false);
        return;
      }
    }

    if (seedTeam && !teamSeeded) {
      try {
        const r = await fetchJson<{ profile?: { team?: unknown[] } }>(
          'POST',
          `/api/spaces/${encodeURIComponent(spaceId)}/team/standard`,
        );
        const count = Array.isArray(r.profile?.team) ? r.profile.team.length : null;
        teamOk = teamSeedOkNote(count);
        setFin((p) => ({ ...p, teamOk }));
        setTeamSeeded(true);
      } catch (e) {
        // 登记那一发的成句留在原地：它成了，不能被这一发的失败一起抹掉
        const note = teamSeedFailNote(e);
        setFin((p) => ({ ...p, teamFail: note }));
        log('error', note);
        setFinishing(false);
        return;
      }
    }

    setFinishing(false);
    const regBits = regOk ?? '一项没登记（server 报 0 项）';
    // server 在同一发里交代的「只披露不登记」项要人读完再走：拿关窗抹掉它就是「200 但带残缺」
    if (regWarn.length) {
      log('info', `项目「${name.trim()}」收尾：${regBits}，另有 ${regWarn.length} 项只披露不登记——先看画面那几行。`);
      return;
    }
    // 同一发里 server 报回 0 项：红句已经在画面上，拿关窗抹掉它就是把「一项没落」说成「登记好了」
    if (regZero) {
      log('info', `项目「${name.trim()}」收尾：${regBits}——画面那句读完再走。`);
      return;
    }
    leaveProject(`项目「${name.trim()}」收尾：${regBits}${teamOk ? ` · ${teamOk}` : ''}。工作目录已带上。`);
  };

  const kindCount = (k: string) => items.filter((it) => it.kind === k).length;
  /** 两发都已成（或人没要班底）：这一按不再打任何请求，只是走出去 */
  const nothingLeftToFire = registered && (teamSeeded || !seedTeam);

  return (
    <div className="pw-backdrop" onClick={close}>
      <div className="pw-modal" role="dialog" aria-modal="true" aria-label="新建项目向导" onClick={(e) => e.stopPropagation()}>
        <div className="pw-head">
          <b>{step === 0 ? '⚡ 30 秒新建项目' : '勾选要接进来的能力'}</b>
          <button className="registry-form-close" aria-label="关闭向导" onClick={close}>✕</button>
        </div>

        {step === 0 ? (
          <>
            <p className="pw-sub">给项目起个名字、指一下它在本机的根目录。向导会自动发现里面的仓库/技能/规则并登记，跑任务的工作目录也会自动带上。</p>
            <div className="pw-field">
              <label>项目名称 *</label>
              <input
                autoFocus
                value={name}
                placeholder="如：商品目录服务"
                onChange={(e) => setName(e.target.value)}
              />
              {autoId && <span className="pw-hint">项目 ID：{autoId}（自动生成）</span>}
            </div>
            <div className="pw-field">
              <label>根目录（绝对路径）*</label>
              <input
                value={dir}
                placeholder="/Users/you/work/my-service"
                onChange={(e) => setDir(e.target.value)}
              />
              <span className="pw-hint">下一步会只读扫描这个目录：发现什么登记什么，不改盘上任何文件。</span>
            </div>
            {dirPre.note && <p className="pw-fail" role="status">{dirPre.note.text}</p>}
            {collision && <p className="pw-fail" role="status">{collision}</p>}
            {spacesFail && <p className="pw-fail" role="status">{spacesFail}</p>}
            {createNote.note && <p className="pw-fail" role="status">{createNote.note.text}</p>}
            <div className="pw-ops">
              <button onClick={close}>取消</button>
              <button className="primary" disabled={creating || !name.trim() || !dir.trim()} onClick={() => void createAndScan()}>
                {creating ? '创建并扫描中…' : '创建项目并扫描 →'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="pw-sub">
              项目 <b>{name.trim()}</b>（{spaceId}）的档案已建好。
              {probeFail ? '下面说的是只读扫描那一发：' : <>在 <code>{dir.trim()}</code> 发现 {items.length} 项，勾选要登记的：</>}
            </p>
            {probeFail ? (
              <>
                <div className="pw-field">
                  <label>根目录（写错了就在这格改：改完只重扫这一发，项目档案那一发不再打）</label>
                  <input value={dir} onChange={(e) => setDir(e.target.value)} />
                </div>
                <div className="settings-fail-row">
                  <p className="pw-fail" role="status">{probeFail}</p>
                  <button disabled={probeBusy} onClick={retryProbe}>
                    {probeBusy ? '扫描中…' : '🔍 再扫一次'}
                  </button>
                </div>
                {dirPre.note && <p className="pw-fail" role="status">{dirPre.note.text}</p>}
              </>
            ) : items.length === 0 ? (
              <p className="pw-hint" style={{ padding: '6px 2px' }}>
                这个目录下没探出仓库/文档/技能——没关系，直接完成；之后随时在「设置 → 能力注册」扫描或单项登记。
              </p>
            ) : (
              <div className="pw-items">
                <div className="pw-items-head">
                  <button
                    className="link"
                    onClick={() => setSelected(items.length && selected.size === items.length ? new Set() : new Set(items.map((_, i) => i)))}
                  >
                    {selected.size === items.length ? '全不选' : '全选'}
                  </button>
                  <span className="pw-hint">
                    仓库 {kindCount('repo')} · 文档 {kindCount('doc')} · 技能 {kindCount('skill')} · 规则 {kindCount('rule')}
                  </span>
                </div>
                {items.map((it, i) => (
                  <label key={i} className="pw-item">
                    <input
                      type="checkbox"
                      checked={selected.has(i)}
                      onChange={(e) =>
                        setSelected((p) => {
                          const next = new Set(p);
                          if (e.target.checked) next.add(i);
                          else next.delete(i);
                          return next;
                        })
                      }
                    />
                    <span className="pw-item-kind">{KIND_LABELS[it.kind] ?? it.kind}</span>
                    <b>{it.name}</b>
                    <span className="pw-item-detail" title={KIND_HINTS[it.kind] ?? ''}>{it.detail}</span>
                  </label>
                ))}
              </div>
            )}
            <label className="pw-team">
              <input type="checkbox" checked={seedTeam} onChange={(e) => setSeedTeam(e.target.checked)} />
              装填首发班底（规划 / 实现 / 评审 / 验收 / 沉淀 五个角色）
            </label>

            {/* 收尾那两发的读数按动词分格各占一行：登记成了几项 / 哪些只披露不登记 / 哪一发没成 */}
            {fin.regOk && <p className="pw-ok" role="status">{fin.regOk}</p>}
            {fin.regWarn.map((w, i) => (
              <p key={i} className="pw-warn" role="status">{w}</p>
            ))}
            {fin.regFail && <p className="pw-fail" role="status">{fin.regFail}</p>}
            {fin.teamOk && <p className="pw-ok" role="status">{fin.teamOk}</p>}
            {fin.teamFail && <p className="pw-fail" role="status">{fin.teamFail}</p>}

            <div className="pw-ops">
              <button onClick={close}>以后再说（项目已建好）</button>
              <button className="primary" disabled={finishing} onClick={() => void (nothingLeftToFire ? leaveProject(`项目「${name.trim()}」收尾：登记那发已经过了，这次只是走出去。`) : finish())}>
                <Icon name="check" size={12} />{' '}
                {finishing ? '登记中…' : nothingLeftToFire ? '知道了：切过去开用' : `✓ 完成：登记 ${selected.size} 项并开始使用`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
