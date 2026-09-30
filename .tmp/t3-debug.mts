import { checkGraphRequirements } from '../packages/server/src/orchestrate/registry-check.ts';
import { matchesTarget } from '../packages/server/src/orchestrate/registry-refs.ts';
import type { DagGraph, RegistryEntry } from '@paneflow/shared';

const get = async (url: string) => (await fetch(url)).json();

const registry = await get('http://127.0.0.1:4310/api/registry') as { entries: RegistryEntry[] };
const graph = (await get('http://127.0.0.1:4310/api/graphs/t3-demo')) as DagGraph;

console.log('requires:', JSON.stringify(graph.requires));
for (const e of registry.entries) {
  console.log('entry', e.id, e.kind, 'enabled=' + e.enabled, 'hit=' + matchesTarget(e, 'openai/gpt-5-codex'));
}
console.log(JSON.stringify(checkGraphRequirements(graph, registry.entries).slots, null, 1));
