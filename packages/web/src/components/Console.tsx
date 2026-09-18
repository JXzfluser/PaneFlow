import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { runCostLabel } from '../cost.js';
import { useStore } from '../store.js';
import { RunTimeline } from './RunTimeline.js';

type Tab = 'console' | 'timeline' | 'approval' | 'terminal' | 'summary';

const CONSOLE_MIN = 120;
const CONSOLE_MAX_RATIO = 0.75;

function clampConsoleHeight(h: number): number {
  return Math.min(Math.round(window.innerHeight * CONSOLE_MAX_RATIO), Math.max(CONSOLE_MIN, Math.round(h)));
}

export function Console() {
  const logs = useStore((s) => s.logs);
  const runs = useStore((s) => s.runs);
  const activeRunId = useStore((s) => s.activeRunId);
  const nodes = useStore((s) => s.nodes);
  const [tab, setTab] = useState<Tab>('console');
  const [terminal, setTerminal] = useState('');
  const [terminalNode, setTerminalNode] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('pf-console-collapsed') === '1');
  const [height, setHeight] = useState(() =>
    clampConsoleHeight(Number(localStorage.getItem('pf-console-height')) || 240),
  );

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      localStorage.setItem('pf-console-collapsed', v ? '0' : '1');
      return !v;
    });
  };

  const onConsoleResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    let last = startH;
    const move = (ev: MouseEvent) => {
      last = clampConsoleHeight(startH + (startY - ev.clientY));
      setHeight(last);
    };
    const up = () => {
      localStorage.setItem('pf-console-height', String(last));
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const switchTab = (t: Tab) => {
    setTab(t);
    if (collapsed) {
      setCollapsed(false);
      localStorage.setItem('pf-console-collapsed', '0');
    }
  };

  const run = activeRunId ? runs[activeRunId] : null;
  const blockedNodes = run
    ? Object.values(run.nodes).filter((n) => n.state === 'blocked')
    : [];
  const runEvents = run?.events ?? [];

  useEffect(() => {
    if (blockedNodes.length > 0) setTab('approval');
  }, [blockedNodes.length]);

  useEffect(() => {
    bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight);
  }, [logs.length, tab]);

  // poll selected node terminal output
  useEffect(() => {
    if (tab !== 'terminal' || !run || !terminalNode) return;
    let alive = true;
    const pull = () => {
      api
        .nodeLog(run.runId, terminalNode)
        .then((r) => {
          if (alive) setTerminal(r.text);
        })
        .catch(() => {
          if (alive) setTerminal('(无法读取终端输出 — agent 可能已结束)');
        });
    };
    pull();
    const t = setInterval(pull, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [tab, run, terminalNode]);

  return (
    <div
      className={`console${collapsed ? ' collapsed' : ''}`}
      style={collapsed ? undefined : { height }}
    >
      {!collapsed && (
        <div
          className="console-resize"
          title="拖拽调整控制台高度 · 双击复位"
          onMouseDown={onConsoleResize}
          onDoubleClick={() => {
            setHeight(240);
            localStorage.setItem('pf-console-height', '240');
          }}
        />
      )}
      <div className="console-tabs">
        {(
          [
            ['console', `运行日志${logs.length ? ` (${logs.length})` : ''}`],
            ['timeline', `时间线${runEvents.length ? ` (${runEvents.length})` : ''}`],
            ['approval', `审批${blockedNodes.length ? ` ⛔${blockedNodes.length}` : ''}`],
            ['terminal', '终端预览'],
            ['summary', '产物汇总'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} className={tab === id && !collapsed ? 'active' : ''} onClick={() => switchTab(id)}>
            {label}
          </button>
        ))}
        <div className="tabs-end">
          {run && runCostLabel(run) && (
            <span className="run-cost-chip" title="成本账：时长/重试/tokens（unknown = agent 未自报，不估算）">{runCostLabel(run)}</span>
          )}
          <button onClick={toggleCollapsed} title={collapsed ? '展开控制台' : '收起控制台，画布空间更大（点任意标签页也会展开）'}>
            {collapsed ? '⌃ 控制台' : '⌄ 收起'}
          </button>
        </div>
      </div>
      {!collapsed && (
      <div className="console-body" ref={bodyRef}>
        {tab === 'console' &&
          logs.map((l, i) => (
            <div key={i} className={`log-line ${l.level}`}>
              <span className="ts">{l.ts}</span>
              {l.text}
            </div>
          ))}
        {tab === 'timeline' && (
          <RunTimeline
            events={runEvents}
            startedAt={run?.startedAt}
            running={run?.state === 'running'}
            emptyHint={
              run
                ? '本次运行还没有事件记录（可能是埋点上线前的历史运行）。'
                : '当前没有选中的运行。任务开始后，这里按时间顺序记录每一步。'
            }
          />
        )}
        {tab === 'approval' &&
          (blockedNodes.length === 0 ? (
            <div className="log-line">当前没有等待人工审批的节点。</div>
          ) : (
            blockedNodes.map((n) => <ApprovalCard key={n.nodeId} runId={run!.runId} nodeId={n.nodeId} />)
          ))}
        {tab === 'terminal' && (
          <TerminalTab
            runId={run?.runId ?? null}
            nodes={nodes.filter((n) => n.data.dagNode.type === 'agent')}
            value={terminalNode}
            onChange={setTerminalNode}
            text={terminal}
          />
        )}
        {tab === 'summary' && (
          <SummaryView />
        )}
      </div>
      )}
    </div>
  );
}

function ApprovalCard({ runId, nodeId }: { runId: string; nodeId: string }) {
  const node = useStore((s) => s.nodes.find((n) => n.id === nodeId));
  const approve = useStore((s) => s.approve);
  const [terminal, setTerminal] = useState('(加载中…)');
  const [freeText, setFreeText] = useState('');

  useEffect(() => {
    let alive = true;
    const pull = () =>
      api.nodeLog(runId, nodeId).then((r) => alive && setTerminal(r.text || '(空)')).catch(() => alive && setTerminal('(无法读取)'));
    pull();
    const t = setInterval(pull, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [runId, nodeId]);

  return (
    <div className="approval-card">
      <div className="t">⛔ 节点「{node?.data.dagNode.label ?? nodeId}」等待人工审批</div>
      <div className="pre">{terminal.slice(-1200)}</div>
      <div className="actions">
        <button className="primary" onClick={() => approve(runId, nodeId, 'approve')}>✓ 放行</button>
        <button className="danger" onClick={() => approve(runId, nodeId, 'reject')}>✗ 终止任务</button>
        <input
          placeholder="或向 Agent 发送补充指令…"
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && freeText.trim()) {
              approve(runId, nodeId, 'input', freeText.trim());
              setFreeText('');
            }
          }}
        />
      </div>
    </div>
  );
}

function TerminalTab({
  runId,
  nodes,
  value,
  onChange,
  text,
}: {
  runId: string | null;
  nodes: ReturnType<typeof useStore.getState>['nodes'];
  value: string | null;
  onChange: (v: string | null) => void;
  text: string;
}) {
  const log = useStore((s) => s.log);
  const [freeText, setFreeText] = useState('');
  const sendKeys = (keys: string[]) => {
    if (!runId || !value) return;
    void api
      .nodeKeys(runId, value, keys)
      .then(() => log('info', `已发送按键 ${keys.join(',')} → ${value}`))
      .catch((e) => log('error', `发送失败：${String(e.message ?? e)}`));
  };
  return (
    <>
      <div style={{ marginBottom: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        选择节点：
        <select
          className="sm"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">（未选择）</option>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>{n.data.dagNode.label}</option>
          ))}
        </select>
        {runId && value && (
          <>
            <button onClick={() => sendKeys(['escape'])}>esc</button>
            <button onClick={() => sendKeys(['ctrl+c'])}>ctrl+c</button>
            <button onClick={() => sendKeys(['enter'])}>enter</button>
            <input
              placeholder="向终端输入文本后回车…"
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && freeText) {
                  void api
                    .nodeInput(runId, value, freeText)
                    .then(() => log('info', '已发送终端输入'))
                    .catch((err) => log('error', `发送失败：${String(err.message ?? err)}`));
                  setFreeText('');
                }
              }}
              style={{ flex: 1, minWidth: 160, background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', font: 'inherit' }}
            />
          </>
        )}
      </div>
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 11 }}>{text || '（无输出）'}</pre>
    </>
  );
}

/**
 * 归一化 extra 中的列表项为对象数组。
 * extra 是引擎约定的自由结构（Record<string, unknown>），按需求可以是
 * acceptance / assertionResults 数组；防御处理 JSON 里可能的非数组/非对象脏数据。
 */
function itemList(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];
}
function s(v: unknown): string {
  return v == null ? '' : String(v);
}

function SummaryView() {
  const runs = useStore((s) => s.runs);
  const activeRunId = useStore((s) => s.activeRunId);
  const nodes = useStore((s) => s.nodes);
  const run = activeRunId ? runs[activeRunId] : null;
  if (!run) return <div className="log-line">尚无运行记录。</div>;
  return (
    <div>
      {Object.values(run.nodes)
        .filter((n) => n.artifact)
        .map((n) => {
          const label = nodes.find((x) => x.id === n.nodeId)?.data.dagNode.label ?? n.nodeId;
          const a = n.artifact!;
          const extra = (a.extra ?? {}) as Record<string, unknown>;
          const acceptance = itemList(extra.acceptance);
          const assertionResults = itemList(extra.assertionResults);
          return (
            <div key={n.nodeId} className="run-summary">
              <span className="nid">{label}</span>{' '}
              <span style={{ color: 'var(--text-dim)' }}>
                [{a.source === 'file' ? '结果文件' : a.source === 'output-fallback' ? '输出回退' : '无产物'}]
              </span>
              {a.summary && <div>{a.summary}</div>}
              {a.files && a.files.length > 0 && <div style={{ color: 'var(--text-dim)' }}>文件：{a.files.join('、')}</div>}
              {a.errors && a.errors.length > 0 && <div style={{ color: 'var(--err)' }}>错误：{a.errors.join('；')}</div>}
              {acceptance.length > 0 && (
                <div className="rs-block">
                  <div className="rs-head">验收断言（{acceptance.length}）</div>
                  {acceptance.map((c, i) => (
                    <div key={i} className="rs-row">
                      <span className="rs-id">{s(c.id)}</span>
                      <span>{s(c.assertion)}</span>
                      {s(c.verify_method) && <span className="rs-ev">验证方法：{s(c.verify_method)}</span>}
                    </div>
                  ))}
                </div>
              )}
              {assertionResults.length > 0 && (
                <div className="rs-block">
                  <div className="rs-head">断言核对（{assertionResults.length}）</div>
                  {assertionResults.map((r, i) => {
                    const st = s(r.status);
                    const stCls = st === 'ok' ? 'ok' : st === 'fail' ? 'fail' : st === 'n/a' ? 'na' : 'other';
                    return (
                      <div key={i} className="rs-row">
                        <span className="rs-id">{s(r.id)}</span>
                        <span className={`rs-check ${stCls}`}>{st || '未知'}</span>
                        {s(r.evidence) && <span className="rs-ev">{s(r.evidence)}</span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      {Object.values(run.nodes).every((n) => !n.artifact) && <div className="log-line">尚无节点产物。</div>}
    </div>
  );
}
