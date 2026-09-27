import { useEffect, useRef, useState } from 'react';

/** 单行输入字段。validate 返回非空字符串即视为校验失败，作为错误提示展示。 */
export interface ModalField {
  key: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  validate?: (value: string, all: Record<string, string>) => string | null;
}

/**
 * 勾选框。值与 fields 走同一条通道（勾上='1'，没勾=''），所以 onSubmit 不必再学一套形状。
 * `defaultChecked` 的用法约束：破坏性的加料选项（连带删产物等）一律留默认不勾——
 * 原生 confirm 那条「点取消=保留产物（默认）」的口径搬进模态后要有个落点，落在这里而不是话术里。
 */
export interface ModalCheck {
  key: string;
  label: string;
  defaultChecked?: boolean;
}

export interface ModalRequest {
  title: string;
  /** 说明文字（可选） */
  message?: string;
  /** 需要输入的字段；为空且 checks 也为空即纯确认弹窗 */
  fields?: ModalField[];
  checks?: ModalCheck[];
  confirmText?: string;
  danger?: boolean;
  /** 提交回调：抛错则把错误信息显示在弹窗内，不关闭 */
  onSubmit: (values: Record<string, string>) => void | Promise<void>;
}

export const CHECK_ON = '1';

/** 读数直白：勾了就是 '1'，没勾就是 ''（调用侧别各自 `!!values.x` 猜形状） */
export const isChecked = (values: Record<string, string>, key: string): boolean => values[key] === CHECK_ON;

const initialValues = (req: ModalRequest): Record<string, string> => {
  const init: Record<string, string> = {};
  for (const f of req.fields ?? []) init[f.key] = f.defaultValue ?? '';
  for (const c of req.checks ?? []) init[c.key] = c.defaultChecked ? CHECK_ON : '';
  return init;
};

/**
 * 统一的小模态（D3）：替代 window.prompt / window.confirm。
 * 支持多字段、逐字段校验、勾选框、Enter 提交、Esc 取消、提交中禁用按钮。
 * 服务端返的错误原文（`fetchJson` 抛的 `Error.message`）显示在弹窗内且不关窗——
 * 拒答要连着那句「先改掉哪几处再来」一起看得见，弹一次 toast 就消失不算说过。
 */
export function PromptModal({ req, onClose }: { req: ModalRequest; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(req));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // 有输入框就聚焦第一个；纯确认框里没有任何可输入的落脚点，焦点归主按钮，
    // 否则它停在 body 上——Tab 序随机、Enter 也不提交。
    if ((req.fields ?? []).length) {
      firstRef.current?.focus();
      firstRef.current?.select();
    } else confirmRef.current?.focus();
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
        {(req.checks ?? []).map((c) => (
          <label key={c.key} className="pm-check" htmlFor={`pmc-${c.key}`}>
            <input
              id={`pmc-${c.key}`}
              type="checkbox"
              checked={values[c.key] === CHECK_ON}
              disabled={busy}
              onChange={(e) => {
                setValues((v) => ({ ...v, [c.key]: e.target.checked ? CHECK_ON : '' }));
                setErr(null);
              }}
            />
            <span>{c.label}</span>
          </label>
        ))}
        {err && <div className="hint pm-err">{err}</div>}
        <div className="close-row">
          <button onClick={onClose} disabled={busy}>取消</button>
          <button
            ref={confirmRef}
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
