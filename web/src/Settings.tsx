import { useEffect, useState, type FormEvent } from 'react';
import { ArrowDown, CodeXml, FileCode2, LoaderCircle, RefreshCw, Save, SlidersHorizontal } from 'lucide-react';
import { problem, projectUrl, request, send } from './api';
import { Dialog, ErrorNotice, Loading, pretty, sourceNames } from './components';
import type { ApiProblem, ConfigDocument, PromptTemplate } from './types';

export function ConfigEditor({ projectId, projectTitle, onSaved }: { projectId: string | null; projectTitle?: string; onSaved: () => void }) {
  const [scope, setScope] = useState<'workspace' | 'project'>('workspace');
  const [documents, setDocuments] = useState<Record<string, ConfigDocument>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<ApiProblem | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const scopeKey = scope === 'workspace' ? 'workspace' : `project:${projectId}`;
  const path = `/api/config${scope === 'project' ? `?project=${encodeURIComponent(projectId!)}` : ''}`;
  const document = documents[scopeKey];
  const draft = drafts[scopeKey] ?? '';
  const dirty = Boolean(document && draft !== document.yaml);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null); setSaved(false);
    request<ConfigDocument>(path, { signal: controller.signal }).then((data) => {
      setDocuments((current) => ({ ...current, [scopeKey]: data }));
      setDrafts((current) => ({ ...current, [scopeKey]: current[scopeKey] ?? data.yaml }));
    }).catch((cause) => { if (!controller.signal.aborted) setError(problem(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, scopeKey]);

  async function reload() {
    setLoading(true); setError(null); setSaved(false); setDiscardOpen(false);
    try {
      const data = await request<ConfigDocument>(path);
      setDocuments((current) => ({ ...current, [scopeKey]: data }));
      setDrafts((current) => ({ ...current, [scopeKey]: data.yaml }));
    } catch (cause) { setError(problem(cause)); }
    finally { setLoading(false); }
  }

  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(null); setSaved(false);
    try {
      const data = await send<ConfigDocument>(path, 'PUT', { yaml: draft });
      setDocuments((current) => ({ ...current, [scopeKey]: data }));
      setDrafts((current) => ({ ...current, [scopeKey]: data.yaml }));
      setSaved(true); onSaved();
    } catch (cause) { setError(problem(cause)); }
    finally { setSaving(false); }
  }

  return (
    <div className="config-view">
      <div className="page-heading"><div><p className="eyebrow">工作室配置 / CONFIGURATION</p><h1>规则，留给你决定。</h1><p>模型、画质、审查与预算都来自 YAML。项目覆盖工作区，工作区覆盖仓库默认值。</p></div><span className="heading-mark"><SlidersHorizontal size={30} strokeWidth={1.2} aria-hidden="true" /></span></div>
      <div className="config-scope-row"><div className="segmented" aria-label="选择配置作用范围"><button type="button" aria-pressed={scope === 'workspace'} className={scope === 'workspace' ? 'active' : ''} disabled={loading || saving} onClick={() => setScope('workspace')}>整个工作区</button><button type="button" aria-pressed={scope === 'project'} className={scope === 'project' ? 'active' : ''} disabled={!projectId || loading || saving} onClick={() => setScope('project')}>当前作品</button></div><span>{scope === 'workspace' ? '影响工作区内的所有作品' : `仅影响「${projectTitle ?? projectId}」`}</span></div>
      <div className="config-inheritance"><span>仓库默认</span><ArrowDown size={13} aria-hidden="true" /><span className={scope === 'workspace' ? 'inheritance-selected' : ''}>工作区 config.yaml</span><ArrowDown size={13} aria-hidden="true" /><span className={scope === 'project' ? 'inheritance-selected' : ''}>项目 project.yaml</span><small>后者深度覆盖前者</small></div>
      {error && <ErrorNotice error={error} onRetry={() => dirty ? setDiscardOpen(true) : void reload()} />}
      {document?.validation_error && <ErrorNotice error={document.validation_error} />}
      {loading && <Loading>正在读取{scope === 'workspace' ? '工作区' : '项目'}配置</Loading>}
      {saved && <p className="save-confirmation" role="status">配置已由服务端验证并保存到{scope === 'workspace' ? '工作区' : '本项目'}。</p>}
      {document && <form onSubmit={save}>
        <section className="code-editor"><div className="editor-heading"><div><FileCode2 size={16} aria-hidden="true" /><label htmlFor="yaml-editor">{scope === 'workspace' ? 'config.yaml' : `${projectId}/project.yaml`}</label>{dirty && <span className="draft-label">未保存</span>}</div><button className="button button-small editor-reload" type="button" disabled={loading || saving} onClick={() => dirty ? setDiscardOpen(true) : void reload()}><RefreshCw size={14} aria-hidden="true" />从磁盘重载</button></div><textarea id="yaml-editor" className="code-textarea" value={draft} onChange={(event) => { const content = event.target.value; setDrafts((current) => ({ ...current, [scopeKey]: content })); setSaved(false); }} spellCheck={false} autoCapitalize="none" autoComplete="off" disabled={saving} /><div className="editor-footer"><span>YAML · UTF-8</span><span>{draft.length.toLocaleString('zh-CN')} 字符 · 校验在服务端完成</span></div></section>
        <div className="editor-save-row"><p>读取和保存失败时，输入内容会保留；任务轮询不会覆盖草稿。</p><button className="button button-primary" type="submit" disabled={loading || saving || !dirty}>{saving ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}保存{scope === 'workspace' ? '工作区' : '项目'}配置</button></div>
        <div className="effective-config"><details className="paper-panel"><summary>查看合并后的最终配置</summary><pre>{pretty(document.merged)}</pre></details><details className="paper-panel"><summary>查看每项配置的来源</summary><div className="table-scroll"><table className="data-table"><thead><tr><th scope="col">配置路径</th><th scope="col">生效来源</th></tr></thead><tbody>{Object.entries(document.sources).map(([name, source]) => <tr key={name}><td><code>{name}</code></td><td>{sourceNames[source] ?? source}</td></tr>)}</tbody></table></div></details></div>
      </form>}
      <div className="env-note"><span className="eyebrow">密钥不写在这里</span><p>在 YAML 中用 <code>llm.provider</code> 选择文本服务（<code>openai</code> / <code>deepseek</code>），用 <code>review.provider</code> 选择图像审查服务（<code>openai</code> / <code>deepseek</code>），用 <code>image.provider</code> 选择生图服务（<code>openai</code> / <code>seedream</code> / <code>qwen</code>）。图像审查包含文字识别与画面检查，所选服务和模型须支持图像输入；<code>review.enabled: false</code> 时不需要审查密钥。</p><p>在工作区 <code>.env</code> 中按服务商配置 <code>OPENAI_API_KEY</code>、<code>DEEPSEEK_API_KEY</code>、<code>ARK_API_KEY</code>（Seedream）或 <code>DASHSCOPE_API_KEY</code>（Qwen）。各路由可用 <code>base_url</code> 和 <code>api_key_env</code> 覆盖地址与密钥变量名；OpenAI 默认沿用 <code>openai</code> 配置。密钥状态仅表示变量有值，未验证密钥或模型能力。此界面不收集或保存 API 密钥。</p></div>
      <div className="env-note"><span className="eyebrow">可选图床 · 默认关闭</span><p><code>export.imgbed.enabled: true</code> 后，章节导出会上传选定的最终阅读图到 <code>export.imgbed.base_url</code>（默认 <code>https://img.011203.xyz</code>）。通常上传 JPEG；<code>export.reading_image_kb: null</code> 时上传最终 PNG。不会上传设定参考图或历史候选；选定的待复核图也会上传。本地阅读、HTML 和 PDF 保留本地文件。</p><p>图床上传 Token 放进环境变量或工作区 <code>.env</code> 的 <code>IMG_BED_TOKEN</code>，需有 <code>upload</code> 权限；站点认证码可用 <code>IMG_BED_AUTH_CODE</code>，两者都有时优先 Token。这不是 <code>CLOUDFLARE_API_TOKEN</code>，不要在 YAML 中填写密钥。工作区开启会由项目继承；关闭只停止今后上传，不会撤回已公开的图片。</p></div>
      {discardOpen && <Dialog title="重新读取磁盘配置？" eyebrow="未保存的修改" onClose={() => setDiscardOpen(false)}><p className="dialog-description">读取成功后，将用磁盘上的 YAML 替换当前草稿。读取失败时，草稿仍然保留。</p><div className="dialog-actions"><button className="button button-quiet" onClick={() => setDiscardOpen(false)}>继续编辑</button><button className="button button-ink" onClick={() => void reload()}>重载并放弃修改</button></div></Dialog>}
    </div>
  );
}

export function PromptEditor({ projectId, projectTitle }: { projectId: string; projectTitle: string }) {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selectedName, setSelectedName] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<ApiProblem | null>(null);
  const [reload, setReload] = useState(0);
  const selected = templates.find((template) => template.name === selectedName) ?? templates[0];
  const draft = selected ? drafts[selected.name] ?? selected.content : '';
  const dirty = Boolean(selected && draft !== selected.content);
  const visible = templates.filter((template) => template.name.toLowerCase().includes(search.toLowerCase()));

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null); setSaved(false);
    request<{ templates: PromptTemplate[] }>(`${projectUrl(projectId)}/prompts`, { signal: controller.signal }).then((data) => {
      setTemplates(data.templates);
      setDrafts((current) => {
        const next = { ...current };
        for (const template of data.templates) next[template.name] ??= template.content;
        return next;
      });
      setSelectedName((current) => current || data.templates[0]?.name || '');
    }).catch((cause) => { if (!controller.signal.aborted) setError(problem(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [projectId, reload]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setSaving(true); setError(null); setSaved(false);
    try {
      const data = await send<PromptTemplate>(`${projectUrl(projectId)}/prompts/${encodeURIComponent(selected.name)}`, 'PUT', { content: draft });
      setTemplates((current) => current.map((template) => template.name === data.name ? data : template));
      setDrafts((current) => ({ ...current, [data.name]: data.content }));
      setSaved(true);
    } catch (cause) { setError(problem(cause)); }
    finally { setSaving(false); }
  }

  return (
    <div className="prompts-view">
      <div className="page-heading"><div><p className="eyebrow">提示词工坊 / PROMPT WORKSHOP</p><h1>给 AI 的话，也能细细打磨。</h1><p>查看「{projectTitle}」当前生效的模板。编辑后保存为项目覆盖，不修改仓库或工作区原件。</p></div><button className="button button-quiet" disabled={saving || loading} onClick={() => setReload((value) => value + 1)}><RefreshCw size={16} aria-hidden="true" />刷新模板清单</button></div>
      {error && <ErrorNotice error={error} onRetry={() => setReload((value) => value + 1)} />}
      {loading && <Loading>正在读取生效的提示词模板</Loading>}
      <div className="prompt-workspace">
        <aside className="prompt-directory"><label className="field prompt-search"><span>查找模板 <small>{templates.length} 个</small></span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="输入模板路径…" /></label><nav aria-label="提示词模板">{visible.map((template) => <button type="button" key={template.name} className={`prompt-item ${selected?.name === template.name ? 'active' : ''}`} aria-current={selected?.name === template.name ? 'true' : undefined} disabled={saving} onClick={() => { setSelectedName(template.name); setSaved(false); setError(null); }}><span><CodeXml size={15} aria-hidden="true" /><code>{template.name}</code>{drafts[template.name] !== undefined && drafts[template.name] !== template.content && <span className="unsaved-dot" aria-label="有未保存的修改" />}</span><small>{sourceNames[template.source]}</small></button>)}</nav>{!loading && !visible.length && <p className="field-help prompt-no-results">{templates.length ? '没有匹配的模板。' : '服务端尚未提供提示词模板。'}</p>}</aside>
        <div className="prompt-edit-area">{selected ? <form onSubmit={save}>
          <div className="prompt-title"><h2>{selected.name}</h2><span className={`source-tag source-${selected.source}`}>{sourceNames[selected.source]}</span></div>
          {saved && <p className="save-confirmation" role="status">已保存为本项目的提示词覆盖。</p>}
          <section className="code-editor"><div className="editor-heading"><div><FileCode2 size={16} aria-hidden="true" /><label htmlFor="prompt-editor">生效模板正文</label>{dirty && <span className="draft-label">未保存</span>}</div><span className="editor-language">Handlebars / Markdown</span></div><textarea id="prompt-editor" className="code-textarea" value={draft} onChange={(event) => { const content = event.target.value; setDrafts((current) => ({ ...current, [selected.name]: content })); setSaved(false); }} spellCheck={false} autoComplete="off" autoCapitalize="none" disabled={saving} /><div className="editor-footer"><span>整文件覆盖 · 保留模板变量</span><span>{draft.length.toLocaleString('zh-CN')} 字符</span></div></section>
          <div className="editor-save-row"><p>保存至 projects/{projectId}/prompts/{selected.name}</p><button className="button button-primary" type="submit" disabled={saving || loading || !dirty}>{saving ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}{selected.source === 'project' ? '保存项目模板' : '保存为项目模板'}</button></div>
          <div className="prompt-syntax-note"><strong>保留变量，也保留约束。</strong><p>支持 <code>{'{{变量}}'}</code>、条件、循环与共享片段。变量缺失由服务端严格检查；这里编辑的是模板，不会调用模型。</p></div>
        </form> : !loading && <div className="empty-state"><CodeXml size={34} strokeWidth={1.2} aria-hidden="true" /><h2>还没有可编辑的模板。</h2><p>本地服务提供模板清单后，就可以查看和编辑生效内容。</p></div>}</div>
      </div>
    </div>
  );
}
