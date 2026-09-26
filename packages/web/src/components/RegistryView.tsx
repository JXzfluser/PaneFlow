import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.js';
import { Icon } from './Icon.js';
import {
  buildRegistryPayload,
  formFieldsFor,
  formatWhen,
  groupEntriesByKind,
  kindGroupLabel,
  missingRequiredFields,
  probeOf,
  refCountOf,
  rejectedSummary,
  REGISTRY_NAME_FIELD,
  sourceLabel,
  specRows,
  type RegistryEntryView,
  type RegistryFormValues,
  type RegistryListResponse,
} from '../registry-view.js';

/**
 * v14 X1 注册中心（M0 可感面）：一张表 + 一组动词，登记走表单、**永远不写 JSON**。
 * 家规：判定全在 server——label / rejected.why / 400 error 都是 server 给的一句人话，原样转述；
 * 这里不重算 id、不校 spec 形状（必填齐没齐是 UI 礼节不是校验）、不把「缺读数」画成 0。
 */
export function RegistryView() {
  const log = useStore((s) => s.log);
  const [data, setData] = useState<RegistryListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  // 对某条目最近一次写失败的服务端原文（进详情抽屉披露，不 toast 完就蒸发）
  const [writeErrors, setWriteErrors] = useState<Record<string, string>>({});

  const [formOpen, setFormOpen] = useState(false);
  const [formKind, setFormKind] = useState('model');
  const [formName, setFormName] = useState('');
  const [formValues, setFormValues] = useState<RegistryFormValues>({});
  const [formError, setFormError] = useState<string | null>(null);
  // 表单选项源：网关档下拉 + 型号候选（探得清单，不是自由发挥的白名单——仍可直接填）
  const [gwProfiles, setGwProfiles] = useState<{ id: string; name: string }[]>([]);
  const [modelCandidates, setModelCandidates] = useState<string[]>([]);
  const [catalogNote, setCatalogNote] = useState<string | null>(null);

  const load = useCallback(() =>
    api
      .registryList()
      .then((r) => {
        setData(r);
        setLoadError(null);
      })
      .catch((e: Error) => setLoadError(e.message)),
  []);

  useEffect(() => {
    void load();
  }, [load]);

  const ensureFormOptions = useCallback(() => {
    api
      .gatewayProfiles()
      .then((r) => setGwProfiles(r.profiles.map((p) => ({ id: p.id, name: p.name }))))
      .catch((e: Error) => setCatalogNote(`网关档清单读不出：${e.message}`));
    api
      .gatewayCatalog()
      .then((r) => {
        setModelCandidates([...new Set(r.profiles.flatMap((p) => p.models))]);
        const errs = r.profiles.filter((p) => p.error).map((p) => `${p.name}：${p.error}`);
        setCatalogNote(errs.length ? `型号探得不全：${errs.join('；')}` : null);
      })
      .catch((e: Error) => setCatalogNote(`型号清单探读失败：${e.message}`));
  }, []);

  const refreshCatalog = () => {
    setCatalogNote('型号清单刷新中…');
    api
      .gatewayCatalog(true)
      .then((r) => {
        setModelCandidates([...new Set(r.profiles.flatMap((p) => p.models))]);
        const errs = r.profiles.filter((p) => p.error).map((p) => `${p.name}：${p.error}`);
        setCatalogNote(errs.length ? `型号探得不全：${errs.join('；')}` : null);
      })
      .catch((e: Error) => setCatalogNote(`型号清单刷新失败：${e.message}`));
  };

  const openForm = () => {
    const next = !formOpen;
    setFormOpen(next);
    // 表单选项（网关档/型号候选）只在首次打开时探一次；失败文案是 server 原话，不拦登记
    if (next && gwProfiles.length === 0 && modelCandidates.length === 0 && catalogNote === null) ensureFormOptions();
  };

  const switchKind = (kind: string) => {
    setFormKind(kind);
    setFormValues({});
    setFormError(null);
  };

  const setValue = (key: string, v: string | boolean) =>
    setFormValues((vs) => ({ ...vs, [key]: v }));

  const submit = async () => {
    const missing = missingRequiredFields(formKind, formName, formValues);
    if (missing.length) {
      setFormError(`请先填写：${missing.join('、')}`);
      return;
    }
    const payload = buildRegistryPayload(formKind, formName, formValues);
    if (!payload) {
      setFormError('这一类还没长表单字段，界面不登记不认识的形状');
      return;
    }
    setBusy('form');
    try {
      await api.registryAdd(payload);
      setFormOpen(false);
      setFormName('');
      setFormValues({});
      setFormError(null);
      await load();
      log('info', `注册中心：已登记「${payload.name}」`);
    } catch (e) {
      // 服务端的 400 一句人话原样inline挂出；已经填的内容一个字不清
      setFormError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const recordWriteError = (id: string, msg: string) =>
    setWriteErrors((m) => ({ ...m, [id]: msg }));

  const toggleEnabled = async (entry: RegistryEntryView) => {
    setBusy(entry.id);
    try {
      const r = await api.registryPatch(entry.id, { enabled: !entry.enabled });
      setData((d) => (d ? { ...d, entries: d.entries.map((e) => (e.id === r.entry.id ? r.entry : e)) } : d));
    } catch (e) {
      recordWriteError(entry.id, (e as Error).message);
      void load(); // 以服务端实态为准回滚本地显示
    } finally {
      setBusy(null);
    }
  };

  const remove = async (entry: RegistryEntryView) => {
    setBusy(entry.id);
    try {
      await api.registryDelete(entry.id);
      setDetailId((d) => (d === entry.id ? null : d));
      await load();
      log('info', `注册中心：已删除「${entry.name}」`);
    } catch (e) {
      recordWriteError(entry.id, (e as Error).message);
      log('error', `注册中心：删除「${entry.name}」失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const groups = data ? groupEntriesByKind(data.entries, data.knownKinds) : [];
  const rejectedText = data ? rejectedSummary(data.rejected) : null;
  const kinds = data?.knownKinds ?? [];

  return (
    <div className="registry-view">
      <div className="registry-head">
        <div>
          <h2>注册中心</h2>
          <p className="settings-hint">
            能力清单的一张表：登记、启停、删除都走这里的表单，不用写 JSON。
            判定全在服务端，本页只渲染它给的话。
            {data?.schema ? ` 表内 schema 版本 v${data.schema.version}${data.schema.writtenBy ? `（${data.schema.writtenBy} 写的）` : ''}。` : ''}
          </p>
        </div>
        <button className="primary" onClick={openForm}>
          + 登记一项
        </button>
      </div>

      {loadError && (
        <p className="registry-load-fail">注册表读不出：{loadError}</p>
      )}

      {rejectedText && data && (
        <div className="registry-rejected">
          <p>{rejectedText}</p>
          <ul>
            {data.rejected.map((r) => (
              <li key={r.id}>
                <code>{r.id}</code> — {r.why}
              </li>
            ))}
          </ul>
        </div>
      )}

      {formOpen && (
        <div className="registry-form">
          <div className="registry-form-field">
            <label htmlFor="reg-kind">能力类型</label>
            <select
              id="reg-kind"
              value={formKind}
              onChange={(ev) => switchKind(ev.target.value)}
            >
              {(kinds.length ? kinds : [formKind]).map((k) => (
                <option key={k} value={k}>
                  {kindGroupLabel(k)}
                </option>
              ))}
            </select>
          </div>

          {formFieldsFor(formKind) ? (
            <>
              <div className="registry-form-field">
                <label htmlFor="reg-name">{REGISTRY_NAME_FIELD.label} *</label>
                <input
                  id="reg-name"
                  value={formName}
                  placeholder={REGISTRY_NAME_FIELD.hint}
                  onChange={(ev) => setFormName(ev.target.value)}
                />
              </div>
              {formFieldsFor(formKind)!.map((f) => {
                if (f.type === 'checkbox') {
                  return (
                    <label className="registry-form-check" key={f.key}>
                      <input
                        type="checkbox"
                        checked={formValues[f.key] === true}
                        onChange={(ev) => setValue(f.key, ev.target.checked)}
                      />
                      {f.label}
                      {f.hint && <span className="settings-hint">（{f.hint}）</span>}
                    </label>
                  );
                }
                return (
                  <div className="registry-form-field" key={f.key}>
                    <label htmlFor={`reg-${f.key}`}>
                      {f.label}
                      {f.required ? ' *' : ''}
                    </label>
                    {f.type === 'select' ? (
                      <select
                        id={`reg-${f.key}`}
                        value={typeof formValues[f.key] === 'string' ? (formValues[f.key] as string) : ''}
                        onChange={(ev) => setValue(f.key, ev.target.value)}
                      >
                        <option value="">不指定</option>
                        {gwProfiles.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <>
                        <input
                          id={`reg-${f.key}`}
                          list={f.key === 'model' ? 'pf-registry-model-candidates' : undefined}
                          value={typeof formValues[f.key] === 'string' ? (formValues[f.key] as string) : ''}
                          placeholder={f.hint}
                          onChange={(ev) => setValue(f.key, ev.target.value)}
                        />
                        {f.key === 'model' && (
                          <>
                            <datalist id="pf-registry-model-candidates">
                              {modelCandidates.map((m) => (
                                <option key={m} value={m} />
                              ))}
                            </datalist>
                            <button className="link" type="button" onClick={refreshCatalog}>
                              刷新型号清单
                            </button>
                          </>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
              {catalogNote && <p className="settings-hint">{catalogNote}</p>}
            </>
          ) : (
            <p className="settings-hint">这一类还没长表单字段，界面不登记不认识的形状。</p>
          )}

          {formError && <p className="registry-form-error">{formError}</p>}
          <div className="registry-form-ops">
            <button
              className="ghost"
              onClick={() => {
                setFormOpen(false);
                setFormError(null);
              }}
            >
              取消
            </button>
            <button className="primary" disabled={busy === 'form'} onClick={() => void submit()}>
              登记
            </button>
          </div>
        </div>
      )}

      {!data && !loadError && <p className="settings-hint">读取中…</p>}

      {groups.map((g) => (
        <section className="registry-group" key={g.kind}>
          <h3>
            {g.label}
            <span className="registry-count">{g.entries.length} 项</span>
          </h3>
          {g.entries.length === 0 ? (
            <p className="settings-hint registry-empty">
              还没有登记的{g.label}——点右上「+ 登记一项」，从表单填进去。
            </p>
          ) : (
            <table className="registry-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>配置读数</th>
                  <th>来源</th>
                  <th title="停用=留着但不再被选，不是删除">启用</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {g.entries.map((e) => {
                  const refs = refCountOf(e);
                  const probe = probeOf(e);
                  return (
                    <Fragment key={e.id}>
                      <tr className={e.enabled ? '' : 'registry-row-off'}>
                        <td>
                          <b>{e.name}</b>
                          {refs !== null && <span className="registry-chip" title="R2 引用账">被引用 {refs}</span>}
                          {probe && (
                            <span className={`dot ${probe.ok ? 'ok' : 'bad'}`} title={probe.detail || undefined} />
                          )}
                        </td>
                        <td className="registry-label">{e.label}</td>
                        <td><span className="registry-chip">{sourceLabel(e.source)}</span></td>
                        <td>
                          <input
                            type="checkbox"
                            checked={e.enabled}
                            disabled={busy === e.id}
                            title={e.enabled ? '点击停用（留着但不再被选）' : '点击启用'}
                            onChange={() => void toggleEnabled(e)}
                          />
                        </td>
                        <td className="registry-ops">
                          <button
                            className="link"
                            onClick={() => setDetailId((d) => (d === e.id ? null : e.id))}
                          >
                            {detailId === e.id ? '收起' : '详情'}
                          </button>
                          <button
                            className="sm ghost danger"
                            disabled={busy === e.id}
                            onClick={() => void remove(e)}
                            title="删除条目（禁用请用左边的开关）"
                          >
                            <Icon name="trash" size={12} /> 删除
                          </button>
                        </td>
                      </tr>
                      {detailId === e.id && (
                        <tr className="registry-detail-row">
                          <td colSpan={5}>
                            <dl className="registry-detail">
                              <dt>id</dt>
                              <dd><code>{e.id}</code>（不可变；改名=重新登记）</dd>
                              <dt>登记于</dt>
                              <dd>{formatWhen(e.createdAt) || '—'}</dd>
                              <dt>改于</dt>
                              <dd>{formatWhen(e.updatedAt) || '—'}</dd>
                              {specRows(e.spec).map((row) => (
                                <div key={row.key}>
                                  <dt>{row.label}</dt>
                                  <dd>{row.text}</dd>
                                </div>
                              ))}
                              {writeErrors[e.id] && (
                                <>
                                  <dt>最近写入失败</dt>
                                  <dd className="registry-detail-fail">{writeErrors[e.id]}</dd>
                                </>
                              )}
                            </dl>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </div>
  );
}
