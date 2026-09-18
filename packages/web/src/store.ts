import { create } from 'zustand';
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react';
import type { DagGraph, DagNode, DagNodeType, EdgeCondition, NodeRunState, RunRecord, TemplateVariable } from '@paneflow/shared';
import { autosaveChanged, graphToRfParts, rfToGraph, type GraphMeta, type PfEdgeData, type PfNode, type PfNodeData } from './graph-serialization.js';
import { setSpace as setApiSpace, getSpace, api } from './api.js';
import { validateDag } from '@paneflow/shared';

export type ThemeName = 'dark' | 'light';

export const THEMES: { id: ThemeName; label: string; icon: string }[] = [
  { id: 'dark', label: '暗夜', icon: '🌙' },
  { id: 'light', label: '浅色', icon: '☀️' },
];

function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme;
}

function initialTheme(): ThemeName {
  const saved = localStorage.getItem('pf-theme') as ThemeName | null;
  const t = saved && THEMES.some((x) => x.id === saved) ? saved : 'light'; // D5: 亮色为默认
  applyTheme(t);
  return t;
}
export type AppView = 'tasks' | 'orchestrate' | 'runs' | 'settings';

/** 视图白名单 + 存储键：改默认落地页时递增版本号，让老用户也吃到新默认（A2） */
const VIEW_KEY = 'pf-view-v2';
const VIEWS: AppView[] = ['tasks', 'orchestrate', 'runs', 'settings'];

function initialView(): AppView {
  const saved = localStorage.getItem(VIEW_KEY) as AppView | null;
  return saved && VIEWS.includes(saved) ? saved : 'tasks';
}

export type { PfNodeData, PfNode, PfEdgeData } from './graph-serialization.js';
export type PfEdge = Edge<PfEdgeData>;
export type { GraphMeta };

export interface ConsoleLog {
  ts: string;
  level: 'info' | 'warn' | 'error';
  text: string;
}

interface PfStore {
  graphName: string;
  nodes: PfNode[];
  edges: Edge[];
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  canvasDirty: boolean;
  logs: ConsoleLog[];
  runs: Record<string, RunRecord>;
  activeRunId: string | null;
  wsOk: boolean;
  herdrOk: boolean | null;
  cwd: string;
  agentKinds: string[];
  templateList: DagGraph[];
  theme: ThemeName;
  view: AppView;
  /** 当前项目空间（响应式镜像 localStorage 的 pf-space，D4） */
  space: string;
  graphVariables: TemplateVariable[];
  graphMeta: GraphMeta;

  setView: (view: AppView) => void;
  /** 切换项目空间：更新 api 上下文 + 刷新模板 + 清空画布 */
  switchSpace: (id: string) => void;
  setTheme: (theme: ThemeName) => void;
  setGraphVariables: (v: TemplateVariable[]) => void;
  setGraphMeta: (m: GraphMeta) => void;
  setCwd: (cwd: string) => void;
  setHealth: (herdrOk: boolean | null, wsOk: boolean) => void;
  setAgentKinds: (kinds: string[]) => void;
  setTemplates: (graphs: DagGraph[]) => void;
  /** 批量并入运行记录（任务视图挂载时拉历史；按当前空间过滤） */
  mergeRuns: (records: RunRecord[]) => void;
  log: (level: ConsoleLog['level'], text: string) => void;
  select: (id: string | null) => void;
  selectEdge: (id: string | null) => void;
  markDirty: () => void;
  updateEdgeCondition: (edgeId: string, condition: EdgeCondition | undefined) => void;
  restoreAutosave: () => boolean;

  onNodesChange: (changes: NodeChange<PfNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (conn: Connection) => void;

  addNode: (type: DagNodeType, position: { x: number; y: number }) => void;
  /** 空态一键骨架：开始 → Agent → 结束（连好线），给完全的新手一个立刻能跑的起点 */
  scaffoldStarter: () => void;
  updateNodeConfig: (nodeId: string, patch: Partial<DagNode['config']>) => void;
  renameGraph: (name: string) => void;
  loadGraph: (graph: DagGraph) => void;
  toGraph: () => DagGraph;
  clearCanvas: () => void;

  applyRun: (run: RunRecord) => void;
  setActiveRun: (runId: string | null) => void;
  /** 从运行中心打开某次运行：载入其图并镜像状态（跨空间自动切换） */
  openRun: (runId: string) => void;
  approve: (runId: string, nodeId: string, action: 'approve' | 'reject' | 'input', text?: string) => void;
}

let nodeSeq = 1;

export const useStore = create<PfStore>((set, get) => ({
  graphName: '未命名流水线',
  nodes: [],
  edges: [],
  selectedNodeId: null,
  selectedEdgeId: null,
  canvasDirty: false,
  logs: [],
  runs: {},
  activeRunId: null,
  wsOk: false,
  herdrOk: null,
  cwd: '',
  agentKinds: ['opencode'],
  templateList: [],
  theme: initialTheme(),
  view: initialView(),
  space: getSpace(),
  graphVariables: [],
  graphMeta: {},

  setView: (view) => {
    localStorage.setItem(VIEW_KEY, view);
    set({ view });
  },

  switchSpace: (id) => {
    if (id === get().space) return;
    setApiSpace(id);
    set({
      space: id,
      nodes: [],
      edges: [],
      selectedNodeId: null,
      selectedEdgeId: null,
      activeRunId: null,
      runs: {},
    });
    void api.listGraphs().then((r) => set({ templateList: r.graphs }));
    get().log('info', `已切换空间 → ${id}`);
  },

  setGraphVariables: (graphVariables) => set({ graphVariables }),
  setGraphMeta: (graphMeta) => set({ graphMeta }),

  setTheme: (theme) => {
    localStorage.setItem('pf-theme', theme);
    applyTheme(theme);
    set({ theme });
  },

  setCwd: (cwd) => set({ cwd }),
  setHealth: (herdrOk, wsOk) => set({ herdrOk, wsOk }),
  setAgentKinds: (agentKinds) => set({ agentKinds }),
  setTemplates: (templateList) => set({ templateList }),
  mergeRuns: (records) =>
    set((s) => {
      const mySpace = localStorage.getItem('pf-space') || 'default';
      const next = { ...s.runs };
      for (const r of records) {
        if (r.spaceId && r.spaceId !== mySpace) continue; // 别的空间的运行不进本视图
        next[r.runId] = r;
      }
      return { runs: next };
    }),
  log: (level, text) =>
    set((s) => ({
      logs: [...s.logs.slice(-400), { ts: new Date().toLocaleTimeString(), level, text }],
    })),
  select: (id) => set({ selectedNodeId: id }),
  selectEdge: (id) => set({ selectedEdgeId: id, selectedNodeId: null }),
  markDirty: () => set({ canvasDirty: true }),
  updateEdgeCondition: (edgeId, condition) =>
    set((s) => ({
      canvasDirty: true,
      edges: s.edges.map((e) =>
        e.id === edgeId
          ? { ...e, data: { ...e.data, condition } }
          : e,
      ),
    })),
  restoreAutosave: () => {
    try {
      // G9：自动保存按空间分 key（旧全局 key 不迁移，视为弃用）
      const raw = localStorage.getItem(autosaveKeyFor(get().space));
      if (!raw) return false;
      const saved = JSON.parse(raw) as {
        graphName: string; nodes: PfNode[]; edges: Edge[];
        graphVariables: TemplateVariable[]; graphMeta: GraphMeta; cwd: string;
      };
      set({
        graphName: saved.graphName ?? '未命名流水线',
        nodes: saved.nodes ?? [],
        edges: saved.edges ?? [],
        graphVariables: saved.graphVariables ?? [],
        graphMeta: saved.graphMeta ?? {},
        cwd: saved.cwd ?? '',
        canvasDirty: true,
        selectedNodeId: null,
      });
      return true;
    } catch {
      return false;
    }
  },

  onNodesChange: (changes) => {
    set((s) => ({ nodes: applyNodeChanges(changes, s.nodes), canvasDirty: true }));
  },
  onEdgesChange: (changes) =>
    set((s) => ({ edges: applyEdgeChanges(changes, s.edges), canvasDirty: true })),
  onConnect: (conn) =>
    set((s) => ({
      canvasDirty: true,
      edges: addEdge({ ...conn, id: `e-${conn.source}-${conn.target}` }, s.edges),
    })),

  addNode: (type, position) => {
    const s0 = get();
    // start / end are unique — replace any existing one
    if (type === 'start' || type === 'end') {
      const existing = s0.nodes.find((n) => n.data.dagNode.type === type);
      if (existing) {
        set({ selectedNodeId: existing.id });
        return;
      }
    }
    const id = type === 'start' || type === 'end' ? type : `${type}-${nodeSeq++}`;
    const defaults: Record<DagNodeType, Partial<DagNode['config']>> = {
      start: {},
      end: {},
      agent: { agentKind: get().agentKinds[0], prompt: '', retryCount: 0, timeoutMs: 0, onFail: 'abort' },
      fanout: {},
      fanin: {},
      pipeline: { pipeline: { template: '', mode: 'wait' } },
    };
    const dagNode: DagNode = {
      id,
      type,
      label: { start: '开始', end: '结束', agent: `Agent ${nodeSeq}`, fanout: '并行 Fan-out', fanin: '汇总 Fan-in', pipeline: '子流水线' }[type],
      position,
      config: defaults[type],
    };
    set((s) => ({ nodes: [...s.nodes, { id, type, position, data: { dagNode } }], canvasDirty: true }));
    set({ selectedNodeId: id });
  },

  scaffoldStarter: () => {
    if (get().nodes.length) return;
    const seq = nodeSeq++;
    const y = 250;
    const mk = (id: string, type: DagNodeType, label: string, x: number, config: DagNode['config']): PfNode => ({
      id,
      type,
      position: { x, y },
      data: { dagNode: { id, type, label, position: { x, y }, config } },
    });
    const agentId = `agent-${seq}`;
    set({
      nodes: [
        mk('start', 'start', '开始', 80, {}),
        mk(agentId, 'agent', `Agent ${seq}`, 400, {
          agentKind: get().agentKinds[0],
          prompt: '',
          retryCount: 0,
          timeoutMs: 0,
          onFail: 'abort',
        }),
        mk('end', 'end', '结束', 760, {}),
      ],
      edges: [
        { id: `e-start-${agentId}`, source: 'start', target: agentId },
        { id: `e-${agentId}-end`, source: agentId, target: 'end' },
      ],
      selectedNodeId: agentId,
      canvasDirty: true,
    });
    get().log('info', '已搭好「开始 → Agent → 结束」：点中间的节点填 Agent 类型和任务指令就能跑');
  },

  updateNodeConfig: (nodeId, patch) =>
    set((s) => ({
      canvasDirty: true,
      nodes: s.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, dagNode: { ...n.data.dagNode, config: { ...n.data.dagNode.config, ...patch } } } } : n,
      ),
    })),

  renameGraph: (name) => set({ graphName: name }),

  loadGraph: (graph) => {
    const parts = graphToRfParts(graph);
    set({
      graphName: graph.name,
      nodes: parts.nodes,
      edges: parts.edges,
      graphVariables: parts.variables,
      graphMeta: parts.meta,
      selectedNodeId: null,
      selectedEdgeId: null,
      canvasDirty: false,
    });
    get().log('info', `已加载模板「${graph.name}」（${graph.nodes.length} 节点）`);
  },

  toGraph: () => {
    const { graphName, nodes, edges, graphVariables, graphMeta } = get();
    return rfToGraph({ name: graphName, nodes, edges, variables: graphVariables, meta: graphMeta });
  },

  clearCanvas: () => {
    set({ nodes: [], edges: [], selectedNodeId: null, selectedEdgeId: null, graphName: '未命名流水线', graphVariables: [], graphMeta: {}, canvasDirty: false });
    get().log('info', '画布已清空');
  },

  applyRun: (run) => {
    const s0 = get();
    // ignore runs from other spaces (engine broadcasts globally)
    const mySpace = localStorage.getItem('pf-space') || 'default';
    if (run.spaceId && run.spaceId !== mySpace) return;
    const prev = s0.runs[run.runId];
    const isActive = s0.activeRunId === null || s0.activeRunId === run.runId;
    set((s) => ({ runs: { ...s.runs, [run.runId]: run } }));
    if (!isActive) return;
    if (s0.activeRunId === null && run.state === 'running') set({ activeRunId: run.runId });
    // mirror run state onto canvas nodes
    set((s) => ({
      nodes: s.nodes.map((n) => {
        const rec = run.nodes[n.id];
        if (!rec) return n;
        return {
          ...n,
          data: {
            ...n.data,
            runState: rec.state,
            agentStatus: rec.agentStatus,
            blocked: rec.state === 'blocked',
          },
        };
      }),
    }));
    // log terminal states exactly once per run (WS replays must not spam)
    const finished = ['completed', 'failed', 'cancelled'].includes(run.state);
    const alreadyLogged = prev && ['completed', 'failed', 'cancelled'].includes(prev.state);
    if (finished && !alreadyLogged) {
      get().log(
        run.state === 'completed' ? 'info' : 'error',
        `流水线 ${run.runId} ${run.state === 'completed' ? '已完成 ✅' : run.state === 'failed' ? '失败 ❌' : '已取消'}（耗时 ${((new Date(run.finishedAt ?? Date.now()).getTime() - new Date(run.startedAt).getTime()) / 1000).toFixed(0)} 秒）`,
      );
    }
  },

  setActiveRun: (runId) => {
    set({ activeRunId: runId });
    const run = runId ? get().runs[runId] : null;
    if (run) get().applyRun(run);
  },

  openRun: (runId) => {
    const run = get().runs[runId];
    if (!run) return;
    // 跨空间：先切空间并刷新该空间的模板列表
    const targetSpace = run.spaceId || 'default';
    if (getSpace() !== targetSpace) {
      setApiSpace(targetSpace);
      set({ space: targetSpace });
      void api.listGraphs().then((r) => set({ templateList: r.graphs }));
    }
    // 载入该 run 的图（画布显示这条流水线本身，而非当前画布残留）
    const parts = graphToRfParts(run.graph);
    set({
      graphName: run.graph.name,
      nodes: parts.nodes,
      edges: parts.edges,
      graphVariables: parts.variables,
      graphMeta: parts.meta,
      selectedNodeId: null,
      selectedEdgeId: null,
      activeRunId: runId,
    });
    get().applyRun(run);
    get().log('info', `已打开运行 ${run.runId}（模板：${run.dagName}）`);
  },

  approve: (runId, nodeId, action, text) => {
    void import('./api.js').then(({ api }) =>
      api
        .approve(runId, nodeId, text ? { action, text } : { action })
        .then(() => get().log('info', `已提交审批动作「${action}」：${nodeId}`))
        .catch((e) => get().log('error', `审批提交失败：${String(e.message ?? e)}`)),
    );
  },
}));

export function graphIssues(): string[] {
  const { toGraph } = useStore.getState();
  return validateDag(toGraph())
    .filter((i) => i.level === 'error')
    .map((i) => i.message);
}

// ---------------------------------------------------------------------------
// 画布自动保存（R2.5 + G3/G9）：防抖 800ms 按空间持久化到 localStorage
// - G3：变更检测用六字段守卫 autosaveChanged（此前只看四个字段，变量/描述改动漏判）
// - G9：切空间先把待存内容写回原空间的 key，随后空画布变更被忽略——
//       杜绝旧实现"800ms 后用 getState() 的新空间空图覆盖上一空间未保存内容"
// ---------------------------------------------------------------------------
export function autosaveKeyFor(space: string): string {
  return `pf-canvas-autosave:${space}`;
}

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let autosavePending: { key: string; payload: unknown } | null = null;

function flushAutosave(): void {
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  if (!autosavePending) return;
  const { key, payload } = autosavePending;
  autosavePending = null;
  try {
    localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // 存储满等异常不阻塞使用
  }
}

useStore.subscribe((state, prev) => {
  if (state.space !== prev.space) {
    flushAutosave(); // 落盘原空间待存内容；本次（空画布）变更不保存
    return;
  }
  if (!autosaveChanged(prev, state)) return;
  // 快照在变更时捕获；flush 不回读 getState()，避免时序错写
  autosavePending = {
    key: autosaveKeyFor(state.space),
    payload: {
      graphName: state.graphName,
      nodes: state.nodes,
      edges: state.edges,
      graphVariables: state.graphVariables,
      graphMeta: state.graphMeta,
      cwd: state.cwd,
    },
  };
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(flushAutosave, 800);
});
