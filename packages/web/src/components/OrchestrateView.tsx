import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { writeFailureNote } from '../write-outcome.js';
import { graphIssues, useStore } from '../store.js';
import { Canvas } from './Canvas.jsx';
import { StepList } from './StepList.jsx';
import { Palette } from './Palette.jsx';
import { PropertyPanel } from './PropertyPanel.jsx';
import { Console } from './Console.jsx';
import { RunDialog } from './RunDialog.jsx';
import { VariablesEditor } from './VariablesEditor.jsx';
import { Icon } from './Icon.js';

type PaneMode = 'list' | 'canvas';
const PANE_KEY = 'pf-pane-mode';

/**
 * 顶栏那一行就地读数。`about`+`at` 只在**描述当前状态的预检句**上出现（记下按下那一刻那一维的读数，
 * 该维一变就撤）；写失败句没有它——那一按成没成是过去的事实，不随画布改写。
 */
interface TopNote {
  tone: 'fail' | 'warn';
  text: string;
  about?: 'graph' | 'name' | 'cwd';
  at?: string;
}

export function OrchestrateView() {
  const graphName = useStore((s) => s.graphName);
  const renameGraph = useStore((s) => s.renameGraph);
  const toGraph = useStore((s) => s.toGraph);
  const clearCanvas = useStore((s) => s.clearCanvas);
  const log = useStore((s) => s.log);
  const runs = useStore((s) => s.runs);
  const activeRunId = useStore((s) => s.activeRunId);
  const openRun = useStore((s) => s.openRun);
  const setActiveRun = useStore((s) => s.setActiveRun);
  const cwd = useStore((s) => s.cwd);
  const setCwd = useStore((s) => s.setCwd);
  const setTemplates = useStore((s) => s.setTemplates);
  const setView = useStore((s) => s.setView);

  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [varsOpen, setVarsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [paneMode, setPaneMode] = useState<PaneMode>(() =>
    localStorage.getItem(PANE_KEY) === 'canvas' ? 'canvas' : 'list',
  );
  const activeRun = activeRunId ? runs[activeRunId] : null;
  const running = activeRun?.state === 'running';
  /**
   * 顶栏四枚写动词的在飞读数（保存 / 停止 / 同步推 / 同步拉）：四枚原本全是 `void fn()`，
   * 点下去一句不说。'stop' 与 'stop-done' 分家同运行中心那枚——「停止指令已发出」≠「这一单已停」，
   * POST 回来时画布上还挂着「运行中」，读数那一刻抹掉就是请人再按一次。
   */
  const [topOp, setTopOp] = useState<'' | 'save' | 'stop' | 'stop-done' | 'push' | 'pull'>('');
  /**
   * 顶栏这六句就地读数（v19 步骤十六）：顶栏是一行高的横条，失败从前只进底部控制台，
   * 画面上就是「按下去没反应」。一句只跟着最后一次按下——顶栏同一时刻只可能有一枚在飞，
   * 不必像卡片那样按 key 分家。红=这一下没成；黄=没配/可以配（不是失败，别拿红冒充）。
   */
  const [topNote, setTopNote] = useState<TopNote | null>(null);
  const noteFail = (text: string, about?: TopNote['about'], at?: string) =>
    setTopNote(about ? { tone: 'fail', text, about, at } : { tone: 'fail', text });

  /**
   * 预检句描述的是「此刻这张图 / 这个名字 / 这个目录」，这三样一改它就变成旧话——画布被修好了还挂着
   * 「无法启动：开始节点只有一个都没有」，比没有读数更坏。所以跟着**读数所描述的那一维**消失，不靠计时器；
   * 写失败那句（「模板没保存（画布上的改动还在）」）记的是刚才那一按，改画布不洗它。
   * 图那一维直接用 `graphIssues()` 的输出质检（它变=那句读数该变），不替 validateDag 猜哪些字段算数。
   */
  const graphFp = useStore(() => graphIssues().join('|'));
  useEffect(() => {
    setTopNote((cur) => {
      if (!cur?.about) return cur;
      const now = cur.about === 'graph' ? graphFp : cur.about === 'name' ? graphName.trim() : cwd.trim();
      return now === cur.at ? cur : null;
    });
  }, [graphFp, graphName, cwd]);

  const switchPane = (mode: PaneMode) => {
    localStorage.setItem(PANE_KEY, mode);
    setPaneMode(mode);
  };

  const run = () => {
    const issues = graphIssues();
    if (issues.length) {
      const why = `无法启动：${issues.join('；')}`;
      log('error', why);
      noteFail(why, 'graph', graphFp);
      return;
    }
    if (!cwd.trim()) {
      const why = '请先填写流水线工作目录（须已存在），或到「项目 → 编辑档案」配置主仓根';
      log('error', why);
      noteFail(why, 'cwd', cwd.trim());
      return;
    }
    setTopNote(null);
    setRunDialogOpen(true);
  };

  const stop = async () => {
    if (!activeRunId) return;
    setTopNote(null);
    setTopOp('stop');
    try {
      await api.stopRun(activeRunId);
      log('warn', '已发送停止指令（会先打断运行中的 Agent）…');
      setTopOp('stop-done');
    } catch (e) {
      setTopOp('');
      // 与运行中心那枚「停止」同一个动词、同一句前缀（同一个动作不许两张脸）
      noteFail(writeFailureNote('停止没发出去（它还在全速跑）', e));
      log('error', `停止失败：${(e as Error).message}`);
    }
  };

  const saveTemplate = async () => {
    const name = graphName.trim();
    if (!name || name === '未命名流水线') {
      const why = '请先在顶栏输入框填写模板名（字母/数字/-/_）再保存';
      log('error', why);
      noteFail(why, 'name', name);
      return;
    }
    setTopNote(null);
    setTopOp('save');
    try {
      await api.saveGraph({ ...toGraph(), name });
      setTemplates((await api.listGraphs()).graphs);
      log('info', `模板「${name}」已保存`);
    } catch (e) {
      noteFail(writeFailureNote('模板没保存（画布上的改动还在）', e));
      log('error', `保存失败：${(e as Error).message}`);
    } finally {
      setTopOp((cur) => (cur === 'save' ? '' : cur));
    }
  };

  // 同步两枚走「更多」菜单：菜单在请求落定前不关，否则「同步中…」那句跟着菜单一起消失，读数等于没做
  const closeMenuWhenSettled = (verb: 'push' | 'pull') => {
    setTopOp((cur) => (cur === verb ? '' : cur));
    setMoreOpen(false);
  };

  const syncPush = async () => {
    setTopNote(null);
    setTopOp('push');
    try {
      const st = await api.syncStatus();
      if (!st.configured) {
        const why =
          '模板云端同步未启用：请到设置页配置 GitHub Token 与默认目标仓库（owner/name）；环境变量 PF_GITHUB_REPO/PF_GITHUB_TOKEN 亦可，env 优先';
        setTopNote({ tone: 'warn', text: why });
        log('warn', why);
        closeMenuWhenSettled('push');
        return;
      }
      await api.syncPush();
      log('info', `模板云端同步已启动（异步推送到 ${st.repo}）`);
    } catch (e) {
      noteFail(writeFailureNote('模板没推出去', e, '推没推成不确定，云端那边要看提交记录'));
      log('error', `模板同步失败：${(e as Error).message}`);
    }
    closeMenuWhenSettled('push');
  };

  const syncPull = async () => {
    setTopNote(null);
    setTopOp('pull');
    try {
      const r = await api.syncPull();
      setTemplates((await api.listGraphs()).graphs);
      log('info', `已拉取 ${r.imported.length} 个云端模板${r.failed.length ? `，失败 ${r.failed.length}` : ''}`);
    } catch (e) {
      noteFail(writeFailureNote('云端模板没拉下来（本地清单照旧）', e));
      log('error', `拉取失败：${(e as Error).message}`);
    }
    closeMenuWhenSettled('pull');
  };

  return (
    <>
      <div className="topbar">
        <div className="tb-group" title="当前画布的模板">
          <input className="gname" value={graphName} onChange={(e) => renameGraph(e.target.value)} placeholder="模板名" style={{ width: 150 }} />
          <button
            onClick={() => void saveTemplate()}
            disabled={topOp === 'save'}
            title={topOp === 'save' ? '模板写入中…' : '保存模板（用左侧模板名）'}
          >
            {topOp === 'save' ? '保存中…' : (<><Icon name="save" /> 保存</>)}
          </button>
        </div>

        <div className="tb-group">
          <button className="primary" title="回到「任务」：一句话描述需求，自动编排（可先看编排预告）" onClick={() => setView('tasks')}>
            <Icon name="pen" /> 描述需求
          </button>
        </div>

        <div className="tb-group pane-switch" title="同一份编排的两种看法：清单给人读，画布给结构改">
          <button className={paneMode === 'list' ? 'on' : ''} onClick={() => switchPane('list')}>清单</button>
          <button className={paneMode === 'canvas' ? 'on' : ''} onClick={() => switchPane('canvas')}>画布</button>
        </div>

        <div className="tb-group" title="流水线运行">
          <input
            className={`gname${cwd ? '' : ' needs-attn'}`}
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="流水线工作目录（必填）"
            title={cwd ? '流水线工作目录' : '尚未设置：填一个已存在的本地目录，或到「项目 → 编辑档案」配置主仓根'}
            style={{ width: 180 }}
          />
          {!running ? (
            <button className="primary" onClick={run}>
              <Icon name="play" /> 运行
            </button>
          ) : (
            <button
              className="danger"
              disabled={topOp === 'stop' || topOp === 'stop-done'}
              title={
                topOp === 'stop'
                  ? '停止指令发送中…'
                  : topOp === 'stop-done'
                    ? '停止指令已发出，等这一单在节点边界收口（再点一下不会更快）'
                    : '停止流水线'
              }
              onClick={() => void stop()}
            >
              {topOp === 'stop' ? '停止中…' : topOp === 'stop-done' ? '等待收口…' : <Icon name="stop" />}
            </button>
          )}
        </div>

        <div className="spacer" />

        <div className="tb-status">
          {activeRunId && (
            <select
              className="sm run-picker"
              value={activeRunId}
              onChange={(e) => openRun(e.target.value)}
              title="切换查看历史运行"
            >
              {Object.values(runs).map((r) => (
                <option key={r.runId} value={r.runId}>
                  {r.runId} · {r.dagName} · {r.state}
                </option>
              ))}
            </select>
          )}
          <div className="tb-more">
            <button title="更多（变量 / 云端同步 / 清空）" aria-label="更多（变量 / 云端同步 / 清空）" onClick={() => setMoreOpen((v) => !v)}>
              <Icon name="more" /> 更多
            </button>
            {moreOpen && (
              <>
                <div className="tb-more-backdrop" onClick={() => setMoreOpen(false)} />
                <div className="tb-more-menu">
                  <button
                    className={varsOpen ? 'on' : ''}
                    onClick={() => {
                      setVarsOpen((v) => !v);
                      setMoreOpen(false);
                    }}
                  >
                    ⎇ 模板变量
                  </button>
                  <button
                    disabled={topOp === 'push' || topOp === 'pull'}
                    onClick={() => { void syncPush(); }}
                  >
                    {topOp === 'push' ? '☁️ 同步中…' : '☁️ 同步模板到 GitHub'}
                  </button>
                  <button
                    disabled={topOp === 'push' || topOp === 'pull'}
                    onClick={() => { void syncPull(); }}
                  >
                    {topOp === 'pull' ? '⬇️ 拉取中…' : '⬇️ 从 GitHub 拉取'}
                  </button>
                  <button
                    onClick={() => {
                      clearCanvas();
                      setMoreOpen(false);
                    }}
                  >
                    🧹 清空画布
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {/* v19 步骤十六：顶栏那一行放不下长句，失败/未配那句紧跟在顶栏下面独占一条（菜单一关就没人说了） */}
      {topNote && (
        <p className={topNote.tone === 'warn' ? 'topbar-warn' : 'topbar-fail'} role="status">
          {topNote.text}
        </p>
      )}
      {varsOpen && <VariablesEditor />}
      <div className="main">
        <Palette />
        {paneMode === 'list' ? <StepList /> : <Canvas />}
        <PropertyPanel />
      </div>
      <Console />
      {runDialogOpen && (
        <RunDialog
          graph={toGraph()}
          onClose={() => setRunDialogOpen(false)}
          onStarted={(runId) => setActiveRun(runId)}
        />
      )}
    </>
  );
}
