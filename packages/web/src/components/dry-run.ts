export interface DryRunResult {
  nodes: {
    id: string;
    type: string;
    label: string;
    role: string | null;
    agentKind: string | null;
    cwd: string | null;
    promptPreview: string | null;
    checks: string[];
    conventions: string | null;
  }[];
  edges: {
    id: string;
    source: string;
    target: string;
    condition: string | null;
    /** v13-K2 否决回边的一句话说明（server `rejectEdgeNote` 原样）；普通边/未带打回标 → 整缺 */
    rejectNote?: string;
  }[];
  warnings: string[];
}
