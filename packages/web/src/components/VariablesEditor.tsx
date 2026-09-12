import { useStore } from '../store.js';
import type { TemplateVariable } from '@paneflow/shared';

/** 模板级变量声明编辑器（R2.4）：运行参数表单由此生成。 */
export function VariablesEditor() {
  const variables = useStore((s) => s.graphVariables);
  const setGraphVariables = useStore((s) => s.setGraphVariables);

  const patch = (i: number, part: Partial<TemplateVariable>) =>
    setGraphVariables(variables.map((v, j) => (j === i ? { ...v, ...part } : v)));

  return (
    <div className="vars-editor">
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <b style={{ fontSize: 12.5, fontFamily: 'var(--font-display)' }}>模板变量（运行参数表单的声明）</b>
        <button
          style={{ marginLeft: 'auto', fontSize: 11 }}
          onClick={() =>
            setGraphVariables([...variables, { key: `var_${Date.now().toString(36)}`, label: '新变量', required: false }])
          }
        >
          + 新增变量
        </button>
      </div>
      {variables.length === 0 && <div className="hint">未声明变量。示例：issue_id（必填）→ 运行时表单会出现该字段，prompt/路径中的 {'{{issue_id}}'} 会被替换。</div>}
      {variables.map((v, i) => (
        <div key={v.key} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
          <input
            value={v.key}
            onChange={(e) => patch(i, { key: e.target.value.replace(/[^a-zA-Z0-9_-]/g, '') })}
            placeholder="key"
            style={{ width: 110, background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 7px', font: 'inherit' }}
            title="变量 key（{{key}} 插值用）"
          />
          <input
            value={v.label}
            onChange={(e) => patch(i, { label: e.target.value })}
            placeholder="名称"
            style={{ width: 110, background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 7px', font: 'inherit' }}
          />
          <input
            value={v.default ?? ''}
            onChange={(e) => patch(i, { default: e.target.value })}
            placeholder="默认值"
            style={{ width: 110, background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 7px', font: 'inherit' }}
          />
          <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 3 }}>
            <input type="checkbox" checked={v.required ?? false} onChange={(e) => patch(i, { required: e.target.checked })} /> 必填
          </label>
          <button className="danger" style={{ padding: '1px 7px', fontSize: 11 }} onClick={() => setGraphVariables(variables.filter((_, j) => j !== i))}>
            🗑
          </button>
        </div>
      ))}
    </div>
  );
}
