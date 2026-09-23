/**
 * Agent lifecycle states as reported by Herdr.
 * `unknown` = agent present but Herdr cannot classify it confidently;
 * treated by the orchestrator as "needs polling reconciliation".
 */
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
