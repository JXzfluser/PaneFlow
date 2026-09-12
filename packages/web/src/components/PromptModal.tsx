import { useEffect, useRef, useState } from 'react';

/** 单行输入字段。validate 返回非空字符串即视为校验失败，作为错误提示展示。 */
export interface ModalField {
  key: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  validate?: (value: string, all: Record<string, string>) => string | null;
}

export interface ModalRequest {
  title: string;
  /** 说明文字（可选） */
  message?: string;
  /** 需要输入的字段；为空即纯确认弹窗 */
  fields?: ModalField[];
  confirmText?: string;
  danger?: boolean;
  /** 提交回调：抛错则把错误信息显示在弹窗内，不关闭 */
  onSubmit: (values: Record<string, string>) => void | Promise<void>;
}

const initialValues = (req: ModalRequest): Record<string, string> => {
  const init: Record<string, string> = {};
  for (const f of req.fields ?? []) init[f.key] = f.defaultValue ?? '';
  return init;
};

/**
 * 统一的小模态（D3）：替代 window.prompt / window.confirm。
 * 支持多字段、逐字段校验、Enter 提交、Esc 取消、提交中禁用按钮。
 */
export function PromptModal({ req, onClose }: { req: ModalRequest; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(req));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    firstRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    for (const f of req.fields ?? []) {
      const e = f.validate?.(values[f.key] ?? '', values);
      if (e) {
        setErr(e);
        return;
      }
    }
    setBusy(true);
    setErr(null);
    try {
      await req.onSubmit(values);
      onClose();
    } catch (e) {
      setErr((e as Error).message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        className="modal modal-prompt"
        role="dialog"
        aria-modal="true"
        aria-label={req.title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{req.title}</h2>
        {req.message && <div className="hint">{req.message}</div>}
        {(req.fields ?? []).map((f, i) => (
          <div key={f.key}>
            <label htmlFor={`pm-${f.key}`}>{f.label}</label>
            <input
              id={`pm-${f.key}`}
              ref={i === 0 ? firstRef : undefined}
              value={values[f.key] ?? ''}
              placeholder={f.placeholder}
              disabled={busy}
              onChange={(e) => {
                setValues((v) => ({ ...v, [f.key]: e.target.value }));
                setErr(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
            />
          </div>
        ))}
        {err && <div className="hint pm-err">{err}</div>}
        <div className="close-row">
          <button onClick={onClose} disabled={busy}>取消</button>
          <button
            className={req.danger ? 'danger' : 'primary'}
            onClick={() => void submit()}
            disabled={busy}
          >
            {busy ? '处理中…' : req.confirmText ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}
