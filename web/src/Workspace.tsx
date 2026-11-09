import { useRef, useState, type FormEvent } from 'react';
import { ArrowRight, ArrowUpRight, BookOpen, Check, FileText, FolderOpen, LoaderCircle, Plus, Upload } from 'lucide-react';
import { problem, projectUrl, request, send } from './api';
import { ComicPlaceholder, dateTime, Dialog, ErrorNotice, RunOptions, StatusBadge } from './components';
import type { ActionProps, ApiProblem, ProjectDetail, View, Workspace } from './types';

export function Studio({ workspace, project, onNew, onView, onChapter, onImported, ...actions }: ActionProps & {
  workspace: Workspace | null; project: ProjectDetail | null; onNew: () => void;
  onView: (view: View) => void; onChapter: (id: string) => void; onImported: (count: number) => void;
}) {
  const [force, setForce] = useState(false);
  const [ignoreLimit, setIgnoreLimit] = useState(false);
  const lockedCount = project?.refs.filter((ref) => ref.status === 'locked').length ?? 0;
  const prepared = Boolean(project && (project.characters.length || project.locations.length || project.chapters.some((chapter) => chapter.summary)));
  const exportedCount = project?.chapters.filter((chapter) => chapter.status === 'exported').length ?? 0;
  const flaggedCount = project?.pages.filter((page) => page.status === 'flagged').length ?? 0;

  return (
    <div className="studio-view">
      <section className={`studio-hero ${project ? 'studio-hero-project' : ''}`}>
        <div className="hero-copy">
          <p className="eyebrow"><span className="tiny-rule" />一本小说，一间工作室</p>
          <h1>{project ? project.project.title : <>把文字，<br />翻成<span className="ink-accent">画面。</span></>}</h1>
          <p className="hero-description">{project ? (project.project.style_desc || '从原稿到设定，从分镜到画页。按自己的节奏，让这本故事慢慢成书。') : '把长篇故事变成一页页彩色漫画。原稿、设定与画页，都安放在你的本地工作区。'}</p>
          {!project && <div className="hero-actions">
            <button className="button button-primary" onClick={onNew} disabled={!workspace}><Plus size={17} aria-hidden="true" />新建第一部作品</button>
            {Boolean(workspace?.projects.length) && <button className="button button-quiet" onClick={() => onView('projects')}>打开作品书架<ArrowRight size={16} aria-hidden="true" /></button>}
          </div>}
          {project && <div className="hero-project-meta"><FolderOpen size={15} aria-hidden="true" /><span>projects/{project.project.id}</span><span className="meta-dot" />文件留在本地</div>}
        </div>
        <div className="hero-art"><ComicPlaceholder /><span className="hero-seal" aria-hidden="true">故事<br />成书</span></div>
      </section>

      {project ? <>
        <div className="stat-rail">
          <div><span className="stat-label">原稿章节</span><strong>{project.chapters.length}<small>章</small></strong></div>
          <div><span className="stat-label">已导出</span><strong>{exportedCount}<small>章</small></strong></div>
          <div><span className="stat-label">已锁定设定</span><strong>{lockedCount}<small>张</small></strong></div>
          <button className={flaggedCount ? 'stat-flagged' : ''} onClick={() => onView('chapters')}><span className="stat-label">待复核画页<ArrowUpRight size={14} aria-hidden="true" /></span><strong>{flaggedCount}<small>页</small></strong></button>
        </div>
        <div className="studio-columns">
          <div className="studio-main-column">
            <ManuscriptPanel project={project} busy={actions.busy} onImported={onImported} />
            <section className="paper-panel prepare-panel">
              <div className="section-heading"><div><p className="eyebrow">02 / 全书预处理</p><h2>先认识故事里的人。</h2></div><span className={`small-stamp ${prepared ? 'stamp-done' : ''}`}>{prepared ? '已有设定' : project.chapters.length ? '待预处理' : '等待原稿'}</span></div>
              <p className="section-description">提取角色、服装与地点，为每一章生成摘要。接下来，再为它们建立统一的视觉设定。</p>
              {prepared && <div className="bible-counts"><span><strong>{project.characters.length}</strong> 位角色</span><span><strong>{project.outfits.length}</strong> 套服装</span><span><strong>{project.locations.length}</strong> 处地点</span></div>}
              <div className="panel-actions">
                <button className="button button-primary" disabled={actions.busy || !actions.canGenerate || !project.chapters.length}
                  onClick={() => actions.onAction({ action: 'prepare', force, ignore_limit: ignoreLimit })}><FileText size={16} aria-hidden="true" />{prepared ? '继续预处理' : '开始全书预处理'}</button>
                {prepared && <button className="button button-quiet" onClick={() => onView('refs')}>去设定图册<ArrowRight size={16} aria-hidden="true" /></button>}
              </div>
              <RunOptions force={force} ignoreLimit={ignoreLimit} onForce={setForce} onIgnoreLimit={setIgnoreLimit} disabled={actions.busy} />
              {!actions.canGenerate && <p className="field-help">配置工作区 .env 中的模型密钥后，才能开始预处理。</p>}
            </section>
          </div>
          <aside className="studio-notes">
            <div className="notes-heading"><span className="eyebrow">制作手记</span><span className="notes-number">01 → 04</span></div>
            <h2>从故事到画页</h2>
            <ol className="workflow-list">
              <li className={project.chapters.length ? 'workflow-done' : 'workflow-current'}><span className="workflow-number">{project.chapters.length ? <Check size={14} /> : '01'}</span><div><strong>原稿入场</strong><p>{project.chapters.length ? `已切分 ${project.chapters.length} 章，原文保存在项目中。` : '选择一份小说原稿，建立章节目录。'}</p></div></li>
              <li className={prepared ? 'workflow-done' : ''}><span className="workflow-number">{prepared ? <Check size={14} /> : '02'}</span><div><strong>全书设定</strong><p>提取角色与世界，整理每章摘要。</p></div></li>
              <li className={lockedCount ? 'workflow-done' : ''}><span className="workflow-number">{lockedCount ? <Check size={14} /> : '03'}</span><div><strong>锁定视觉</strong><p>先选画风，再选服装与地点。锁定后不再替换。</p><button className="text-link" onClick={() => onView('refs')}>打开设定图册<ArrowUpRight size={13} aria-hidden="true" /></button></div></li>
              <li className={exportedCount ? 'workflow-done' : ''}><span className="workflow-number">{exportedCount ? <Check size={14} /> : '04'}</span><div><strong>逐章成书</strong><p>改编、分镜、生图与审查，最后导出阅读页和 PDF。</p><button className="text-link" onClick={() => onView('chapters')}>前往章节稿台<ArrowUpRight size={13} aria-hidden="true" /></button></div></li>
            </ol>
            <div className="local-note"><span className="eyebrow">一条创作约定</span><p>AI 负责制作。<br />你负责给故事定下模样。</p><span>唯一必须的人工环节：锁定设定。</span></div>
          </aside>
        </div>
        {project.chapters.length > 0 && <section className="chapter-peek">
          <div className="section-heading"><div><p className="eyebrow">故事目录</p><h2>下一章，从这里开始。</h2></div><button className="text-link" onClick={() => onView('chapters')}>全部 {project.chapters.length} 章<ArrowRight size={15} aria-hidden="true" /></button></div>
          {project.chapters.slice(0, 3).map((chapter) => <button className="chapter-peek-row" key={chapter.id} onClick={() => onChapter(chapter.id)}>
            <span className="chapter-index">{String(chapter.idx).padStart(2, '0')}</span><strong>{chapter.title || `第 ${chapter.idx} 章`}</strong><StatusBadge status={chapter.status} /><ArrowUpRight size={17} aria-hidden="true" />
          </button>)}
        </section>}
      </> : <section className="first-steps">
        <div><span className="step-index">01</span><h2>收好原稿</h2><p>新建作品，导入 .txt 或 .md 小说，自动整理章节。</p></div>
        <div><span className="step-index">02</span><h2>定下模样</h2><p>从画风、角色到地点，挑选并锁定属于故事的视觉设定。</p></div>
        <div><span className="step-index">03</span><h2>慢慢成书</h2><p>逐章改编与绘制，复核有疑问的画页，导出成册。</p></div>
      </section>}
    </div>
  );
}

function ManuscriptPanel({ project, busy, onImported }: { project: ProjectDetail; busy: boolean; onImported: (count: number) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [force, setForce] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<ApiProblem | null>(null);

  async function importFile() {
    if (!file) return;
    setImporting(true);
    setError(null);
    try {
      const result = await request<{ chapters: number }>(`${projectUrl(project.project.id)}/import${force ? '?force=true' : ''}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) }, body: file,
      });
      onImported(result.chapters);
      setFile(null);
      setForce(false);
      setConfirming(false);
      input.current!.value = '';
    } catch (cause) { setError(problem(cause)); }
    finally { setImporting(false); }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (force) setConfirming(true);
    else void importFile();
  }

  return (
    <section className="paper-panel manuscript-panel">
      <div className="section-heading"><div><p className="eyebrow">01 / 原稿入场</p><h2>{project.chapters.length ? '原稿已就位。' : '故事，从一份原稿开始。'}</h2></div><Upload size={22} strokeWidth={1.5} aria-hidden="true" /></div>
      <p className="section-description">选择小说文件，原文会复制进本地项目，再由服务端自动切章。</p>
      <form onSubmit={submit}>
        <label className={`upload-zone ${file ? 'upload-selected' : ''}`} htmlFor="novel-file">
          <span className="upload-icon"><FileText size={25} strokeWidth={1.5} aria-hidden="true" /></span>
          <span><strong>{file ? file.name : '选择小说原稿'}</strong><small>{file ? `${(file.size / 1024).toFixed(1)} KB · 点击重新选择` : '.txt / .md · 文件只上传至本地服务'}</small></span>
          <span className="upload-choose">浏览文件</span>
          <input ref={input} id="novel-file" type="file" accept=".txt,.md" disabled={busy || importing} onChange={(event) => {
            const selected = event.target.files?.[0];
            if (!selected) return;
            if (!/\.(txt|md)$/i.test(selected.name)) { setError({ message: '请选择 .txt 或 .md 格式的小说文件。' }); return; }
            setFile(selected); setError(null);
          }} />
        </label>
        {project.chapters.length > 0 && <label className="checkbox-label import-force"><input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} disabled={busy || importing} />覆盖已有原稿（旧文件由服务端备份）</label>}
        {error && !confirming && <ErrorNotice error={error} />}
        <div className="panel-actions"><button className="button button-ink" type="submit" disabled={!file || busy || importing || (project.chapters.length > 0 && !force)}>
          {importing ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Upload size={16} aria-hidden="true" />}导入并切分章节
        </button><span className="field-help">导入不调用模型，不产生 AI 花费。</span></div>
      </form>
      {confirming && <Dialog title="确认覆盖小说原稿？" eyebrow="原稿变更" busy={importing} onClose={() => setConfirming(false)}>
        <p className="dialog-description">将用 <strong>{file?.name}</strong> 替换当前原稿，并重新切分章节。服务端会备份旧原稿；已有制作进度可能受影响。</p>
        {error && <ErrorNotice error={error} />}
        <div className="dialog-actions"><button className="button button-quiet" disabled={importing} onClick={() => setConfirming(false)}>保留原稿</button><button className="button button-danger" disabled={importing} onClick={() => void importFile()}>{importing && <LoaderCircle className="spin" size={16} aria-hidden="true" />}确认覆盖并导入</button></div>
      </Dialog>}
    </section>
  );
}

export function Projects({ workspace, selectedId, onSelect, onNew }: {
  workspace: Workspace; selectedId: string | null; onSelect: (id: string) => void; onNew: () => void;
}) {
  return (
    <div className="projects-view">
      <div className="page-heading"><div><p className="eyebrow">你的本地作品集 / LIBRARY</p><h1>每个故事，<br className="mobile-break" />都有自己的位置。</h1><p>一本小说一个项目。原稿、设定与所有画页，分开收好。</p></div><button className="button button-primary" onClick={onNew}><Plus size={17} aria-hidden="true" />新建作品</button></div>
      <div className="library-label"><span>{workspace.projects.length} 部作品</span><span title={workspace.workspace_path}>{workspace.workspace_path}</span></div>
      <div className="project-grid">
        {workspace.projects.map((project, index) => <button className={`project-card ${selectedId === project.id ? 'project-card-active' : ''}`} key={project.id} onClick={() => onSelect(project.id)}>
          <div className={`book-jacket jacket-${index % 3}`}><span className="jacket-id">{project.id}</span><span className="jacket-title">{project.title}</span><span className="jacket-rule" /><span className="jacket-footer">小说 · 漫画改编</span><BookOpen size={23} strokeWidth={1.2} aria-hidden="true" /></div>
          <div className="project-card-copy"><div className="project-card-title"><h2>{project.title}</h2><ArrowUpRight size={19} aria-hidden="true" /></div><p>{project.chapter_count ? `${project.completed_chapters} / ${project.chapter_count} 章已完成` : '尚未导入原稿'}</p><div className="book-progress" aria-label={`${project.completed_chapters} 章已完成，共 ${project.chapter_count} 章`}><span style={{ width: `${project.chapter_count ? Math.min(100, project.completed_chapters / project.chapter_count * 100) : 0}%` }} /></div><div className="project-card-meta"><span>{project.updated_at ? `${dateTime(project.updated_at)} 更新` : project.id}</span>{selectedId === project.id && <span className="selected-label">当前作品</span>}</div></div>
        </button>)}
        <button className="project-add-card" onClick={onNew}><span><Plus size={25} strokeWidth={1.4} aria-hidden="true" /></span><strong>{workspace.projects.length ? '留一个位置给下个故事' : '书架的第一本，等你来写'}</strong><small>新建一个本地项目</small></button>
      </div>
      <p className="library-footnote">封面为文字排版，不是 AI 生成的漫画素材。</p>
    </div>
  );
}

export function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (project: { id: string; title: string }) => void }) {
  const [title, setTitle] = useState('');
  const [id, setId] = useState('');
  const [style, setStyle] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiProblem | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true); setError(null);
    try {
      const result = await send<{ id: string; title: string }>('/api/projects', 'POST', { id: id.trim(), title: title.trim(), ...(style.trim() ? { style: style.trim() } : {}) });
      onCreated(result);
    } catch (cause) { setError(problem(cause)); }
    finally { setSaving(false); }
  }
  return (
    <Dialog title="给故事一个位置。" eyebrow="新建作品 / NEW BOOK" onClose={onClose} busy={saving}>
      <p className="dialog-description">在本地工作区新建一个独立项目，之后再导入小说原稿。</p>
      <form onSubmit={submit} className="form-stack">
        <label className="field"><span>作品标题</span><input autoFocus required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="这本故事叫什么？" disabled={saving} /></label>
        <label className="field"><span>项目 ID</span><input required pattern="[a-z0-9-]+" value={id} onChange={(event) => setId(event.target.value)} placeholder="例如 qinglan" autoCapitalize="none" autoComplete="off" spellCheck={false} aria-describedby="project-id-help" disabled={saving} /><small id="project-id-help">小写字母、数字或连字符，也是本地文件夹的名字。</small></label>
        <label className="field"><span>画风描述 <small>可选</small></span><textarea value={style} onChange={(event) => setStyle(event.target.value)} placeholder="描述你想要的线条、色彩与气氛；留空则使用工作区配置。" rows={3} disabled={saving} /></label>
        {error && <ErrorNotice error={error} />}
        <div className="dialog-actions"><button className="button button-quiet" type="button" disabled={saving} onClick={onClose}>暂不创建</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}创建作品</button></div>
      </form>
    </Dialog>
  );
}
