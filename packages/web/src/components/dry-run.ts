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
  edges: { id: string; source: string; target: string; condition: string | null }[];
  warnings: string[];
}
