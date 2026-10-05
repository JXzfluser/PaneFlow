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
import type { DagGraph, DagNode, DagNodeType, EdgeCondition, GraphRequirement, NodeRunState, RunRecord, TemplateVariable } from '@paneflow/shared';
import { runHasEnded } from '@paneflow/shared';
import { autosaveChanged, graphToRfParts, rfToGraph, type GraphMeta, type PfEdgeData, type PfNode, type PfNodeData } from './graph-serialization.js';
import { setSpace as setApiSpace, getSpace, api } from './api.js';
import { validateDag } from '@paneflow/shared';

export type ThemeName = 'dark' | 'light';

export const THEMES: { id: ThemeName; label: string; icon: string }[] = [
  { id: 'dark', label: '暗夜', icon: '🌙' },
  { id: 'light', label: '浅色', icon: '☀️' },
];

function applyTheme(theme: ThemeName): void {
  // 主题翻转同时改动几乎每个元素的颜色——不掐掉过渡，切换会糊成整页交叉淡化。
  // （测试环境的 document 桩只有 documentElement，故先探测 createElement）
  if (typeof document.createElement !== 'function') {
    document.documentElement.dataset.theme = theme;
    return;
  }
  const kill = document.createElement('style');
  kill.appendChild(document.createTextNode('*,*::before,*::after{transition:none !important}'));
  document.head.appendChild(kill);
  document.documentElement.dataset.theme = theme;
  // 浏览器外壳色（移动地址栏/刘海描边）跟随实主题：light 是默认档，静态 meta 不能写死暗值
  if (typeof document.querySelector === 'function') {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      if (bg) meta.setAttribute('content', bg);
    }
  }
  void document.body.offsetHeight; // 强制 reflow，让上面的规则先落地
  requestAnimationFrame(() => kill.remove());
}

function initialTheme(): ThemeName {
  const saved = localStorage.getItem('pf-theme') as ThemeName | null;
  // v18-UI：暗色为默认（对标 vibex 的暗色专业工具基调；显式选过亮色的用户仍留在亮色）
  const t = saved && THEMES.some((x) => x.id === saved) ? saved : 'dark';
  applyTheme(t);
  return t;
}
export type AppView = 'tasks' | 'orchestrate' | 'runs' | 'projects' | 'caps' | 'settings';

/** 视图白名单 + 存储键：改默认落地页时递增版本号，让老用户也吃到新默认（A2）。
 *  v4：注册中心并入设置页（配置枢纽归一），旧键里的 'registry' 迁到 'settings'；
 *  v5：默认落地页改「任务」（说需求是产品正门），「运行」升格为「看板」（视图 id 不变）。 */
const VIEW_KEY = 'pf-view-v5';
const VIEWS: AppView[] = ['tasks', 'orchestrate', 'runs', 'projects', 'caps', 'settings'];

function initialView(): AppView {
  const saved = localStorage.getItem(VIEW_KEY) ?? localStorage.getItem('pf-view-v4') ?? localStorage.getItem('pf-view-v3');
  // v3 → v4 迁移：老的 'registry' 落点在导航里已不存在，归入设置
  const v = saved === 'registry' ? 'settings' : saved;
  return v && VIEWS.includes(v as AppView) ? (v as AppView) : 'tasks';
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
  /** 新建节点的默认 Agent（health 灌入：本机已安装优先，见 R7-③） */
  defaultAgentKind: string;
  templateList: DagGraph[];
  theme: ThemeName;
  view: AppView;
  /** 当前项目（响应式镜像 localStorage 的 pf-space，D4） */
  space: string;
  graphVariables: TemplateVariable[];
  /**
   * v14-T3 模板带的 `requires` 能力槽。画布**不编辑**它（编辑位在 W5 的手填面清点里给），
   * 这一格的存在只为一条底线：模板作者手写/导入的槽声明，经「打开画布→保存」不能被洗掉
   * （R1 的老教训——画布只认识 UI 渲染得到的字段，其余静默丢，那就是第二起「保存了个寂寞」）。
   */
  graphRequires: GraphRequirement[];
  graphMeta: GraphMeta;
  /** v11-C5：沉淀发布成功计数——WikiSedimentCard 订阅它即时重拉 /api/wiki/state */
  wikiPublishTick: number;

  setView: (view: AppView) => void;
  /** 切换项目：更新 api 上下文 + 刷新模板 + 清空画布 */
  switchSpace: (id: string) => void;
  setTheme: (theme: ThemeName) => void;
  /** v18-UI：档位切换收进 store——侧栏底部与 anywhere 都能调（applyTheme 自带过渡抑制） */
  toggleTheme: () => void;
  setGraphVariables: (v: TemplateVariable[]) => void;
  setGraphMeta: (m: GraphMeta) => void;
  setCwd: (cwd: string) => void;
  setHealth: (herdrOk: boolean | null, wsOk: boolean) => void;
  setAgentKinds: (kinds: string[]) => void;
  setDefaultAgentKind: (kind: string) => void;
  setTemplates: (graphs: DagGraph[]) => void;
  /** v11-C5：沉淀发布成功后 bump wikiPublishTick，设置页卡片据此重拉状态 */
  notifyWikiPublished: () => void;
  /** v17-W：项目新建向导的全局开关——任务页「在哪做」空态与项目页都开它（App 层挂一次） */
  pwOpen: boolean;
  setPwOpen: (v: boolean) => void;
  /** v18-UI：使用指南开关收进 store——入口从顶栏迁到侧栏底部，App 层照旧只挂一份弹窗 */
  guideOpen: boolean;
  setGuideOpen: (v: boolean) => void;
  /** v18-UI 侧栏收缩（localStorage 记忆）：顶栏收缩钮与 rail 态共用；窄屏自动 rail 在 SideNav 算 */
  navCollapsed: boolean;
  setNavCollapsed: (v: boolean) => void;
  /** 批量并入运行记录（任务视图挂载时拉历史；按当前项目过滤） */
  mergeRuns: (records: RunRecord[]) => void;
  log: (level: ConsoleLog['level'], text: string) => void;
  select: (id: string | null) => void;
  selectEdge: (id: string | null) => void;
  markDirty: () => void;
  updateEdgeCondition: (edgeId: string, condition: EdgeCondition | undefined) => void;
  /** v13-K2 把这条连线标成/取消「否决回边」（画布上的打回线） */
  updateEdgeReject: (edgeId: string, reject: boolean) => void;
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
  agentKinds: [], // 唯一来源：/api/health 的 agentKinds（App 启动时灌入），不在前端写死偏好
  defaultAgentKind: '',
  templateList: [],
  theme: initialTheme(),
  view: initialView(),
  space: getSpace(),
  graphVariables: [],
  graphRequires: [],
  graphMeta: {},
  wikiPublishTick: 0,
  pwOpen: false,
  guideOpen: false,
  navCollapsed: typeof localStorage !== 'undefined' ? localStorage.getItem('pf-nav-collapsed') === '1' : false,

  setPwOpen: (v) => set({ pwOpen: v }),
  setGuideOpen: (v) => set({ guideOpen: v }),
  setNavCollapsed: (v) => {
    localStorage.setItem('pf-nav-collapsed', v ? '1' : '0');
    set({ navCollapsed: v });
  },

  setView: (view) => {
    // 工具页（设置/项目）不记忆——它们是"去办事"的页，回应用仍是核心视图
    if (view !== 'settings' && view !== 'projects') {
      localStorage.setItem(VIEW_KEY, view);
    }
    set({ view });
  },

  switchSpace: (id) => {
    if (id === get().space) return;
    setApiSpace(id);
    set({
      space: id,
      nodes: [],
      edges: [],
      graphRequires: [],
      selectedNodeId: null,
      selectedEdgeId: null,
      activeRunId: null,
      runs: {},
    });
    void api.listGraphs().then((r) => set({ templateList: r.graphs }));
    get().log('info', `已切换项目 → ${id}`);
  },

  setGraphVariables: (graphVariables) => set({ graphVariables }),
  setGraphMeta: (graphMeta) => set({ graphMeta }),

  setTheme: (theme) => {
    localStorage.setItem('pf-theme', theme);
    applyTheme(theme);
    set({ theme });
  },
  toggleTheme: () => {
    const cur = get().theme;
    get().setTheme(cur === 'dark' ? 'light' : 'dark');
  },

  setCwd: (cwd) => set({ cwd }),
  setHealth: (herdrOk, wsOk) => set({ herdrOk, wsOk }),
  setAgentKinds: (agentKinds) => set({ agentKinds }),
  setDefaultAgentKind: (defaultAgentKind) => set({ defaultAgentKind }),
  setTemplates: (templateList) => set({ templateList }),
  notifyWikiPublished: () => set((s) => ({ wikiPublishTick: s.wikiPublishTick + 1 })),
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
  updateEdgeReject: (edgeId, reject) =>
    set((s) => ({
      canvasDirty: true,
      edges: s.edges.map((e) =>
        e.id === edgeId
          ? // 取消标记时落回「没这键」而不是 false：与 DagEdge 的省略语义一致，
            // 保存下来的 JSON 不会多出一堆 `reject: false` 让作者误以为这键有意义
            { ...e, data: { ...e.data, reject: reject ? true : undefined } }
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
        graphVariables: TemplateVariable[]; graphRequires?: GraphRequirement[]; graphMeta: GraphMeta; cwd: string;
      };
      set({
        graphName: saved.graphName ?? '未命名流水线',
        nodes: saved.nodes ?? [],
        edges: saved.edges ?? [],
        graphVariables: saved.graphVariables ?? [],
        graphRequires: saved.graphRequires ?? [],
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
      agent: { agentKind: get().defaultAgentKind || get().agentKinds[0], prompt: '', retryCount: 0, timeoutMs: 0, onFail: 'abort' },
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
          agentKind: get().defaultAgentKind || get().agentKinds[0],
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
      graphRequires: parts.requires,
      graphMeta: parts.meta,
      selectedNodeId: null,
      selectedEdgeId: null,
      canvasDirty: false,
    });
    get().log('info', `已加载模板「${graph.name}」（${graph.nodes.length} 节点）`);
  },

  toGraph: () => {
    const { graphName, nodes, edges, graphVariables, graphRequires, graphMeta } = get();
    return rfToGraph({ name: graphName, nodes, edges, variables: graphVariables, meta: graphMeta, requires: graphRequires });
  },

  clearCanvas: () => {
    set({ nodes: [], edges: [], selectedNodeId: null, selectedEdgeId: null, graphName: '未命名流水线', graphVariables: [], graphRequires: [], graphMeta: {}, canvasDirty: false });
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
    const finished = runHasEnded(run.state);
    const alreadyLogged = prev && runHasEnded(prev.state);
    if (finished && !alreadyLogged) {
      get().log(
        run.state === 'completed' ? 'info' : run.state === 'completed-with-failures' ? 'warn' : 'error',
        `流水线 ${run.runId} ${
          run.state === 'completed'
            ? '已完成 ✅'
            : run.state === 'completed-with-failures'
              ? '完成但有失败节点 ⚠'
              : run.state === 'failed'
                ? '失败 ❌'
                : '已取消'
        }（耗时 ${((new Date(run.finishedAt ?? Date.now()).getTime() - new Date(run.startedAt).getTime()) / 1000).toFixed(0)} 秒）`,
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
      graphRequires: parts.requires,
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
      graphRequires: state.graphRequires,
      graphMeta: state.graphMeta,
      cwd: state.cwd,
    },
  };
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(flushAutosave, 800);
});
