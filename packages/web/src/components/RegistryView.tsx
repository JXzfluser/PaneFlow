import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, fetchJson } from '../api.js';
import { useStore } from '../store.js';
import { Icon } from './Icon.js';
import {
  buildRegistryPayload,
  formFieldsFor,
  formatWhen,
  groupEntriesByKind,
  healthDot,
  healthIndex,
  healthTitle,
  isViewEntry,
  kindGroupLabel,
  missingRequiredFields,
  probeNote,
  refCountOf,
  refNote,
  refRows,
  rejectedSummary,
  registrableKinds,
  spaceDocCandidates,
  spaceRepoCandidates,
  REGISTRY_NAME_FIELD,
  sourceLabel,
  specRows,
  whenLabels,
  type RegistryEntryView,
  type RegistryFormField,
  type RegistryFormValues,
  type RegistryHealthReadout,
  type RegistryListResponse,
  type RegistryProbeResponse,
  type SpaceDocCandidateSource,
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
  /**
   * R4 健康点：**独立一刀、后于表到达**（`/api/registry` 保持纯读盘）。
   * `null` 且无错＝还在探（那一格什么都不画，不画灰点冒充「不健康」）；读不出只说健康点这一刀，表照常。
   */
  const [health, setHealth] = useState<Map<string, RegistryHealthReadout> | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  /**
   * X1 单枚探针（`registry probe` 的 UI 落点）：id → 刚做过的那一次回执或失败原话。
   * 与批量那一刀分家存放——批量是「整表扫一遍」，单枚是「我就问这一条」，混进同一张 map
   * 就分不清哪个读数是刚现探的。
   */
  const [probed, setProbed] = useState<Record<string, { res?: RegistryProbeResponse; err?: string }>>({});

  const [formOpen, setFormOpen] = useState(false);
  const [formKind, setFormKind] = useState('model');
  const [formName, setFormName] = useState('');
  const [formValues, setFormValues] = useState<RegistryFormValues>({});
  const [formError, setFormError] = useState<string | null>(null);
  // 表单选项源：网关档下拉 + 型号候选（探得清单，不是自由发挥的白名单——仍可直接填）
  const [gwProfiles, setGwProfiles] = useState<{ id: string; name: string }[]>([]);
  const [modelCandidates, setModelCandidates] = useState<string[]>([]);
  const [catalogNote, setCatalogNote] = useState<string | null>(null);
  /**
   * `skill`/`rule` 表单的候选（v14 A5-1/A5-2）：项目下拉读 `/api/spaces`，文档路径与仓库目录名读
   * **所选项目档案里已有的值**（`GET /api/spaces/:id`）。前端不拼路径、不猜目录：候选读不出来时，
   * 直填那一格照旧可走——候选是省手的，不是白名单。
   */
  const [spaces, setSpaces] = useState<{ id: string; name: string }[]>([]);
  const [spacesNote, setSpacesNote] = useState<string | null>(null);
  const [docCandidates, setDocCandidates] = useState<string[]>([]);
  const [repoCandidates, setRepoCandidates] = useState<string[]>([]);
  const [candidatesNote, setCandidatesNote] = useState<string | null>(null);
  const selectedSpace = typeof formValues.space === 'string' ? formValues.space : '';

  const loadHealth = useCallback((refresh: boolean) => {
    void api
      .registryHealth(refresh)
      .then((r) => {
        setHealth(healthIndex(r));
        setHealthError(null);
      })
      .catch((e: Error) => setHealthError(e.message));
  }, []);

  const load = useCallback(() =>
    api
      .registryList()
      .then((r) => {
        setData(r);
        setLoadError(null);
      })
      .catch((e: Error) => setLoadError(e.message))
      // 表先到、点后到：健康那一刀不 await——网关挂掉时表照样读得出，只有点缺着（R4 分刀的理由）
      .finally(() => void loadHealth(false)),
  [loadHealth]);

  useEffect(() => {
    void load();
  }, [load]);

  const ensureFormOptions = useCallback(() => {
    api
      .gatewayProfiles()
      .then((r) => setGwProfiles(r.profiles.map((p) => ({ id: p.id, name: p.name }))))
      .catch((e: Error) => setCatalogNote(`网关档清单读不出：${e.message}`));
    api
      .listSpaces()
      .then((r) => {
        setSpaces(r.spaces.map((s) => ({ id: s.id, name: s.name })));
        setSpacesNote(null);
      })
      .catch((e: Error) => setSpacesNote(`项目清单读不出：${e.message}`));
    api
      .gatewayCatalog()
      .then((r) => {
        setModelCandidates([...new Set(r.profiles.flatMap((p) => p.models))]);
        const errs = r.profiles.filter((p) => p.error).map((p) => `${p.name}：${p.error}`);
        setCatalogNote(errs.length ? `型号探得不全：${errs.join('；')}` : null);
      })
      .catch((e: Error) => setCatalogNote(`型号清单探读失败：${e.message}`));
  }, []);

  /** 选了项目才去读那一枚档案拿路径候选（不选就不请求；读不出只说候选这一格，直填那条路不受影响） */
  useEffect(() => {
    const wantsCandidates = formKind === 'skill' || formKind === 'rule';
    if (!formOpen || !wantsCandidates || !selectedSpace) {
      setDocCandidates([]);
      setRepoCandidates([]);
      return;
    }
    let dead = false;
    fetchJson<SpaceDocCandidateSource>('GET', `/api/spaces/${encodeURIComponent(selectedSpace)}`)
      .then((p) => {
        if (dead) return;
        const id = p?.id || selectedSpace;
        setDocCandidates(spaceDocCandidates([p], id));
        setRepoCandidates(spaceRepoCandidates([p], id));
        setCandidatesNote(null);
      })
      .catch((e: Error) => {
        if (dead) return;
        setDocCandidates([]);
        setRepoCandidates([]);
        setCandidatesNote(`这个项目的文档与仓库清单读不出：${e.message}（路径仍可直填）`);
      });
    return () => {
      dead = true;
    };
  }, [formOpen, formKind, selectedSpace]);

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
    // 表单选项（网关档/型号候选/项目清单）只在首次打开时各探一次；失败文案是 server 原话，不拦登记
    if (
      next &&
      gwProfiles.length === 0 &&
      modelCandidates.length === 0 &&
      spaces.length === 0 &&
      catalogNote === null &&
      spacesNote === null
    )
      ensureFormOptions();
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

  /**
   * 探一次（只问这一条，吃 server 那份 5min 实探缓存；`refresh=true` 才绕开）。
   * 读数回来了顺手喂给表上那颗点——同一份判据、同一个字段，只是这一枚更新，
   * 于是「我刚探的这条」和「整表上次扫的」不会画成两样。
   */
  const probeOnce = async (entry: RegistryEntryView, refresh = false) => {
    setBusy(entry.id);
    try {
      const res = await api.registryProbe(entry.id, refresh);
      setProbed((m) => ({ ...m, [entry.id]: { res } }));
      if (res.health) {
        const readout = res.health;
        setHealth((m) => {
          const next = new Map(m ?? []);
          next.set(entry.id, readout);
          return next;
        });
      }
    } catch (e) {
      setProbed((m) => ({ ...m, [entry.id]: { err: (e as Error).message } }));
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

  /**
   * 字段的候选集，按字段自己声明的源取（`options`=下拉、`list`=datalist）。
   * 渲染侧不再写死 `key === 'gatewayProfile'` / `key === 'model'`——那种字符串比对加一类字段就得改一处画法。
   * 返回统一 {id,name}：id 是提交值，name 是显示值（型号与路径两样都是自身）。
   */
  const fieldChoices = (f: RegistryFormField): { id: string; name: string }[] => {
    if (f.options === 'spaces') return spaces;
    if (f.options === 'gateway-profiles') return gwProfiles;
    if (f.list === 'models') return modelCandidates.map((m) => ({ id: m, name: m }));
    if (f.list === 'space-docs') return docCandidates.map((p) => ({ id: p, name: p }));
    if (f.list === 'space-repos') return repoCandidates.map((r) => ({ id: r, name: r }));
    return [];
  };

  const listIdFor = (list: NonNullable<RegistryFormField['list']>): string =>
    list === 'models'
      ? 'pf-registry-model-candidates'
      : list === 'space-docs'
        ? 'pf-registry-space-docs'
        : 'pf-registry-space-repos';

  const groups = data ? groupEntriesByKind(data.entries, data.knownKinds, data.viewKinds ?? [], data.kindLabels) : [];
  const rejectedText = data ? rejectedSummary(data.rejected) : null;
  // 表单只问能登记的那几类：出厂清单类（agent-kind）没有表单形状，选它必被 server 拒，不在这里挂出来
  const kinds = registrableKinds(data?.knownKinds ?? [], data?.viewKinds ?? []);

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
        <button
          className="ghost"
          onClick={() => void loadHealth(true)}
          title="绕开服务端 5 分钟实探缓存重新探一遍（表不受影响）"
        >
          重探健康点
        </button>
      </div>

      {loadError && (
        <p className="registry-load-fail">注册表读不出：{loadError}</p>
      )}

      {healthError && (
        <p className="registry-load-fail">
          健康点读不出：{healthError}（表不受影响：那一格没点＝不知道，不是「不健康」）
        </p>
      )}

      {!health && !healthError && (
        <p className="settings-hint">健康点探测中…（与型号清单同一份实探缓存，不拖读表）</p>
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
                  {kindGroupLabel(k, data?.kindLabels)}
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
                const lid = f.list ? listIdFor(f.list) : undefined;
                return (
                  <div className="registry-form-field" key={f.key}>
                    <label htmlFor={`reg-${f.key}`}>
                      {f.label}
                      {f.required ? ' *' : ''}
                    </label>
                    {f.type === 'select' ? (
                      <>
                        <select
                          id={`reg-${f.key}`}
                          value={typeof formValues[f.key] === 'string' ? (formValues[f.key] as string) : ''}
                          onChange={(ev) => setValue(f.key, ev.target.value)}
                        >
                          <option value="">{f.options === 'spaces' ? '选一个项目' : '不指定'}</option>
                          {fieldChoices(f).map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                        {/* 空下拉有两种读法（清单没读到 / 这个项目下真一个候选都没有），分开说，别拿「不指定」糊过去 */}
                        {f.options === 'spaces' && !spaces.length && (
                          <p className="settings-hint">{spacesNote ?? '还没有项目档案可列（先去「项目」里建一个，或直接提交）。'}</p>
                        )}
                      </>
                    ) : (
                      <>
                        <input
                          id={`reg-${f.key}`}
                          list={lid}
                          value={typeof formValues[f.key] === 'string' ? (formValues[f.key] as string) : ''}
                          placeholder={f.hint}
                          onChange={(ev) => setValue(f.key, ev.target.value)}
                        />
                        {lid && (
                          <>
                            <datalist id={lid}>
                              {fieldChoices(f).map((c) => (
                                <option key={c.id} value={c.id} />
                              ))}
                            </datalist>
                            {f.list === 'models' && (
                              <button className="link" type="button" onClick={refreshCatalog}>
                                刷新型号清单
                              </button>
                            )}
                            {f.list === 'space-docs' && !docCandidates.length && (
                              <p className="settings-hint">
                                {selectedSpace
                                  ? candidatesNote ?? '这个项目档案里还没有登记过文档路径——直接填相对路径即可。'
                                  : '先选项目，这里会列出它档案里已有的路径。'}
                              </p>
                            )}
                            {f.list === 'space-repos' && !repoCandidates.length && (
                              <p className="settings-hint">
                                {selectedSpace
                                  ? candidatesNote ?? '这个项目还没登记过仓库目录——直接填目录名即可（留空=全空间都守这条）。'
                                  : '先选项目，这里会列出它档案里已登记的仓库目录。'}
                              </p>
                            )}
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
            {g.view && (
              <span className="registry-chip" title="这一类由版本自带清单生成，不落盘、不登记">
                内置清单
              </span>
            )}
          </h3>
          {g.entries.length === 0 ? (
            <p className="settings-hint registry-empty">
              {g.view
                ? '这一类是版本自带的内置清单，没有可登记的东西（本机没探到货就是正读数，不是没配好）。'
                : `还没有登记的${g.label}——点右上「+ 登记一项」，从表单填进去。`}
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
                  const refList = refRows(e);
                  const readout = health?.get(e.id);
                  const probe = probed[e.id];
                  const pNote = probeNote(probe?.res, probe?.err ?? null);
                  const dot = healthDot(readout);
                  const view = isViewEntry(e);
                  const when = whenLabels(view);
                  return (
                    <Fragment key={e.id}>
                      <tr className={e.enabled ? '' : 'registry-row-off'}>
                        <td>
                          <b>{e.name}</b>
                          {refs !== null && <span className="registry-chip" title="R2 引用账">被引用 {refs}</span>}
                          {dot && <span className={`dot ${dot}`} title={healthTitle(readout)} />}
                        </td>
                        <td className="registry-label">{e.label}</td>
                        <td><span className="registry-chip">{sourceLabel(e.source)}</span></td>
                        <td>
                          {view ? (
                            <span className="registry-label" title="出厂清单没有启停这一格：本机探到货就能用">
                              —
                            </span>
                          ) : (
                            <input
                              type="checkbox"
                              checked={e.enabled}
                              disabled={busy === e.id}
                              title={e.enabled ? '点击停用（留着但不再被选）' : '点击启用'}
                              onChange={() => void toggleEnabled(e)}
                            />
                          )}
                        </td>
                        <td className="registry-ops">
                          <button
                            className="link"
                            onClick={() => setDetailId((d) => (d === e.id ? null : e.id))}
                          >
                            {detailId === e.id ? '收起' : '详情'}
                          </button>
                          {view ? null : (
                            <button
                              className="sm ghost danger"
                              disabled={busy === e.id}
                              onClick={() => void remove(e)}
                              title="删除条目（禁用请用左边的开关）"
                            >
                              <Icon name="trash" size={12} /> 删除
                            </button>
                          )}
                        </td>
                      </tr>
                      {detailId === e.id && (
                        <tr className="registry-detail-row">
                          <td colSpan={5}>
                            <dl className="registry-detail">
                              <dt>id</dt>
                              <dd>
                                <code>{e.id}</code>
                                {view ? '（出厂清单生成，不可改）' : '（不可变；改名=重新登记）'}
                              </dd>
                              <dt>{when.created}</dt>
                              <dd>{formatWhen(e.createdAt) || '—'}</dd>
                              <dt>{when.updated}</dt>
                              <dd>{formatWhen(e.updatedAt) || '—'}</dd>
                              {when.note && (
                                <>
                                  <dt>说明</dt>
                                  <dd>{when.note}</dd>
                                </>
                              )}
                              {specRows(e.spec).map((row) => (
                                <div key={row.key}>
                                  <dt>{row.label}</dt>
                                  <dd>{row.text}</dd>
                                </div>
                              ))}
                              {readout && (
                                <>
                                  <dt>健康</dt>
                                  <dd>
                                    {readout.status === 'live' ? '● 在' : readout.status === 'missing' ? '○ 不在' : `? ${readout.status}`}
                                    ：{readout.detail}
                                    {readout.at ? `（读数时刻 ${formatWhen(readout.at) || readout.at}${readout.cached ? ' · 缓存' : ''}）` : ''}
                                  </dd>
                                </>
                              )}
                              <dt>谁在用</dt>
                              <dd>
                                {refList && refList.length > 0 && (
                                  <div className="registry-refs">
                                    {refList.map((r) => (
                                      <div key={r.key}>{r.text}</div>
                                    ))}
                                  </div>
                                )}
                                <span className={refList === null ? 'registry-detail-note warn' : 'registry-detail-note'}>
                                  {refNote(e, refList)}
                                </span>
                              </dd>
                              <dt>探针</dt>
                              <dd>
                                <button
                                  className="link"
                                  disabled={busy === e.id}
                                  onClick={() => void probeOnce(e)}
                                  title="只探这一条（与服务端 5 分钟实探缓存共用）"
                                >
                                  探一次
                                </button>
                                <button
                                  className="link"
                                  disabled={busy === e.id}
                                  onClick={() => void probeOnce(e, true)}
                                  title="绕开实探缓存现探一遍"
                                >
                                  现探
                                </button>
                              </dd>
                              {pNote && (
                                <>
                                  <dt>探针读数</dt>
                                  <dd className={probe?.err ? 'registry-detail-fail' : undefined}>{pNote}</dd>
                                </>
                              )}
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
