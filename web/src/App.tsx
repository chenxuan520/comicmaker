import { useEffect, useState } from 'react';
import { ArrowRight, BookOpen, ChevronRight, CircleAlert, CodeXml, FolderOpen, LibraryBig, Palette, PanelsTopLeft, Plus, ReceiptText, RefreshCw, SlidersHorizontal, X, type LucideIcon } from 'lucide-react';
import { problem, projectUrl, request, send } from './api';
import BudgetView from './Budget';
import Chapters from './Chapters';
import { actionNames, ErrorNotice, Loading, Warnings } from './components';
import { ActionConfirmation, CancelConfirmation, JobPanel } from './Jobs';
import References from './References';
import { ConfigEditor, PromptEditor } from './Settings';
import { NewProjectDialog, Projects, Studio } from './Workspace';
import type { ActionInput, ApiProblem, Budget, Job, ProjectDetail, View, Workspace } from './types';

const navigation: { id: View; title: string; icon: LucideIcon; secondary?: boolean }[] = [
  { id: 'studio', title: '创作工作台', icon: PanelsTopLeft },
  { id: 'refs', title: '设定图册', icon: Palette },
  { id: 'chapters', title: '章节稿台', icon: BookOpen },
  { id: 'budget', title: '花费账本', icon: ReceiptText },
  { id: 'config', title: '工作室配置', icon: SlidersHorizontal, secondary: true },
  { id: 'prompts', title: '提示词工坊', icon: CodeXml, secondary: true },
];
const viewNames: Record<View, string> = { studio: '创作工作台', projects: '作品书架', refs: '设定图册', chapters: '章节稿台', budget: '花费账本', config: '工作室配置', prompts: '提示词工坊' };
const POLL_INTERVAL_MS = 2500;

export default function App() {
  const [view, setView] = useState<View>('studio');
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaceError, setWorkspaceError] = useState<ApiProblem | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [projectData, setProjectData] = useState<ProjectDetail | null>(null);
  const [projectFailure, setProjectFailure] = useState<{ id: string; error: ApiProblem } | null>(null);
  const [chapterId, setChapterId] = useState<string | null>(null);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [budgetError, setBudgetError] = useState<ApiProblem | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [jobError, setJobError] = useState<ApiProblem | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<ApiProblem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<ActionInput | null>(null);
  const [cancelJob, setCancelJob] = useState<Job | null>(null);
  const [cancelError, setCancelError] = useState<ApiProblem | null>(null);
  const project = projectData?.project.id === selectedId ? projectData : null;
  const projectError = projectFailure?.id === selectedId ? projectFailure.error : null;
  const selectedTitle = project?.project.title ?? workspace?.projects.find((item) => item.id === selectedId)?.title;
  const busy = submitting || job?.status === 'running';
  const canGenerate = Boolean(workspace?.api_key_configured && !workspaceError);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    const controller = new AbortController();
    async function poll() {
      const options = { signal: controller.signal };
      const [workspaceResult, jobResult, budgetResult, projectResult] = await Promise.allSettled([
        request<Workspace>('/api/workspace', options),
        request<{ job: Job | null }>('/api/jobs/current', options),
        request<Budget>('/api/budget', options),
        selectedId ? request<ProjectDetail>(projectUrl(selectedId), options) : Promise.resolve(null),
      ]);
      if (disposed) return;
      if (workspaceResult.status === 'fulfilled') {
        const data = workspaceResult.value;
        setWorkspace(data); setWorkspaceError(null);
        setSelectedId((current) => current ?? data.current_project ?? data.projects[0]?.id ?? null);
      } else setWorkspaceError(problem(workspaceResult.reason));
      if (jobResult.status === 'fulfilled') { setJob(jobResult.value.job); setJobError(null); }
      else {
        setJobError(problem(jobResult.reason));
        if (workspaceResult.status === 'fulfilled') setJob(workspaceResult.value.job);
      }
      if (budgetResult.status === 'fulfilled') { setBudget(budgetResult.value); setBudgetError(null); }
      else setBudgetError(problem(budgetResult.reason));
      if (projectResult.status === 'fulfilled') { setProjectData(projectResult.value); setProjectFailure(null); }
      else if (selectedId) setProjectFailure({ id: selectedId, error: problem(projectResult.reason) });
      const interval = workspaceResult.status === 'fulfilled' ? workspaceResult.value.settings?.poll_interval_ms ?? POLL_INTERVAL_MS : POLL_INTERVAL_MS;
      timer = window.setTimeout(() => void poll(), interval);
    }
    void poll();
    return () => { disposed = true; controller.abort(); window.clearTimeout(timer); };
  }, [selectedId, refresh]);

  function refreshData() { setRefresh((value) => value + 1); }

  function navigate(next: View) {
    setView(next); window.scrollTo({ top: 0 });
  }

  function selectProject(id: string) {
    setSelectedId(id || null); setChapterId(null); setActionError(null); setNotice(null); navigate('studio');
  }

  async function executeAction(input: ActionInput): Promise<boolean> {
    setSubmitting(true); setActionError(null); setNotice(null);
    try {
      const result = await send<{ job: Job }>(`${projectUrl(selectedId!)}/actions`, 'POST', input);
      setJob(result.job); refreshData();
      if (result.job.status === 'failed' || result.job.status === 'cancelled') {
        setActionError(result.job.error ?? { message: result.job.status === 'cancelled' ? '服务端返回：任务已取消。' : '任务执行失败，请查看任务日志。' });
        return false;
      }
      setNotice(`${actionNames[input.action]}${result.job.status === 'completed' ? '已完成' : '任务已启动'}。结果与素材以本地服务返回为准。`);
      return true;
    } catch (cause) { setActionError(problem(cause)); return false; }
    finally { setSubmitting(false); }
  }

  function requestAction(input: ActionInput) {
    setActionError(null);
    if (input.force || input.ignore_limit || input.action === 'redo' || input.action === 'lock') setConfirmation(input);
    else void executeAction(input);
  }

  async function cancel() {
    setSubmitting(true); setCancelError(null);
    try {
      const result = await send<{ job: Job }>(`/api/jobs/${encodeURIComponent(cancelJob!.id)}/cancel`, 'POST');
      setJob(result.job); setCancelJob(null); refreshData();
      setNotice(result.job.status === 'cancelled' ? '服务端确认：任务已取消，已完成进度保留。' : '取消请求已处理，当前任务状态以服务端返回为准。');
    } catch (cause) { setCancelError(problem(cause)); }
    finally { setSubmitting(false); }
  }

  const actions = { busy, canGenerate, onAction: requestAction };
  let content;
  if (view === 'config') content = <ConfigEditor projectId={selectedId} projectTitle={selectedTitle} onSaved={refreshData} />;
  else if (view === 'budget') content = <>{budgetError && <ErrorNotice error={{ ...budgetError, message: `账本更新失败：${budgetError.message}` }} onRetry={refreshData} />}{budget ? <BudgetView budget={budget} projects={workspace?.projects ?? []} selectedId={selectedId} onRefresh={refreshData} onConfig={() => navigate('config')} /> : !budgetError && <Loading>正在读取花费账本</Loading>}</>;
  else if (view === 'projects') content = workspace ? <Projects workspace={workspace} selectedId={selectedId} onSelect={selectProject} onNew={() => setNewProjectOpen(true)} /> : !workspaceError && <Loading />;
  else if (selectedId && !project) content = projectError ? <div className="empty-state"><FolderOpen size={35} strokeWidth={1.2} aria-hidden="true" /><h1>这部作品暂时无法读取。</h1><p>上次选择仍然保留。请检查本地服务后重试。</p><button className="button button-ink" onClick={refreshData}><RefreshCw size={16} aria-hidden="true" />重新读取作品</button></div> : <Loading>正在打开「{selectedTitle ?? selectedId}」</Loading>;
  else if (view === 'refs' && project) content = <References key={selectedId} project={project} {...actions} />;
  else if (view === 'chapters' && project) content = <Chapters key={selectedId} project={project} selectedChapterId={chapterId} onSelectChapter={setChapterId} {...actions} />;
  else if (view === 'prompts' && project) content = <PromptEditor key={selectedId} projectId={project.project.id} projectTitle={project.project.title} />;
  else if (view !== 'studio') content = <div className="empty-state"><LibraryBig size={36} strokeWidth={1.2} aria-hidden="true" /><h1>先为故事建一个项目。</h1><p>选择或新建一部作品，才能使用{viewNames[view]}。</p><button className="button button-primary" disabled={!workspace} onClick={() => setNewProjectOpen(true)}><Plus size={16} aria-hidden="true" />新建作品</button></div>;
  else content = <Studio key={selectedId ?? 'empty'} workspace={workspace} project={project} onNew={() => setNewProjectOpen(true)} onView={navigate} onChapter={(id) => { setChapterId(id); navigate('chapters'); }} onImported={(count) => { setNotice(`原稿已导入，服务端切分出 ${count} 章。`); refreshData(); }} {...actions} />;

  return (
    <div className="app-layout">
      <a className="skip-link" href="#main-content">跳到创作区域</a>
      <aside className="sidebar">
        <button className="brand" onClick={() => navigate('studio')} title="返回创作工作台"><span className="brand-symbol" aria-hidden="true"><span /><span /><span /></span><span><strong>页间<span className="brand-period">.</span></strong><small>LOCAL COMIC STUDIO</small></span></button>
        <div className="project-picker"><div className="picker-label"><label htmlFor="current-project">当前作品</label><button className={`icon-button ${view === 'projects' ? 'active' : ''}`} aria-label="查看作品书架" title="查看作品书架" onClick={() => navigate('projects')}><LibraryBig size={17} /></button></div><select id="current-project" value={selectedId ?? ''} disabled={!workspace || !workspace.projects.length} onChange={(event) => selectProject(event.target.value)}><option value="" disabled>{workspace?.projects.length ? '选择一部作品' : '还没有作品'}</option>{workspace?.projects.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select><button className="new-project-link" onClick={() => setNewProjectOpen(true)} disabled={!workspace}><Plus size={14} aria-hidden="true" />新建作品</button></div>
        <nav className="sidebar-nav" aria-label="工作室导航">{navigation.map(({ id, title, icon: Icon, secondary }) => <button key={id} className={`${view === id ? 'active' : ''} ${secondary ? 'nav-secondary' : ''} ${id === 'config' ? 'nav-divider' : ''}`} aria-current={view === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon size={19} strokeWidth={1.65} aria-hidden="true" /><span>{title}</span>{view === id && <span className="nav-active-dot" aria-hidden="true" />}</button>)}</nav>
        <div className="sidebar-footer"><div className="local-status"><span className={workspaceError ? 'offline-dot' : workspace ? 'online-dot' : 'connecting-dot'} aria-hidden="true" />{workspaceError ? '本地连接中断' : workspace ? '本地运行，文件在这里' : '正在连接本地服务'}</div><p title={workspace?.workspace_path}>{workspace?.workspace_path ?? '等待工作区路径'}</p><span className="footer-motto">故事在这里，文件也在这里。</span></div>
      </aside>
      <div className="main-shell">
        <header className="topbar"><div className="breadcrumb"><span>工作室</span><ChevronRight size={13} aria-hidden="true" />{selectedTitle && view !== 'projects' && view !== 'budget' && view !== 'config' && <><span className="breadcrumb-project">{selectedTitle}</span><ChevronRight size={13} aria-hidden="true" /></>}<strong>{viewNames[view]}</strong></div><div className="topbar-actions"><span className="topbar-local"><span aria-hidden="true" />仅在本地</span><button className="icon-button refresh-button" aria-label="刷新工作区和任务状态" title="刷新工作区" onClick={refreshData}><RefreshCw size={17} /></button><button className="button button-small button-ink" onClick={() => setNewProjectOpen(true)} disabled={!workspace}><Plus size={15} aria-hidden="true" /><span>新建作品</span></button></div></header>
        <main id="main-content" className="main-content" tabIndex={-1}>
          {workspaceError && <div className="server-notice notice" role="alert"><CircleAlert size={21} aria-hidden="true" /><div className="notice-copy"><strong>未能连接本地漫画服务</strong><p>在项目目录运行 <code>comic serve</code>。开发模式的 <code>/api</code> 代理连接 <code>127.0.0.1:4321</code>；自动重试期间保留已读取的数据。</p><small>{workspaceError.message}{workspaceError.code ? ` · ${workspaceError.code}` : ''}</small></div><button className="button button-small button-quiet" onClick={refreshData}>重试<ArrowRight size={14} aria-hidden="true" /></button></div>}
          {workspace && !workspace.api_key_configured && <div className="key-notice notice"><span className="key-notice-mark" aria-hidden="true">!</span><div className="notice-copy"><strong>故事可以先整理，模型密钥还需要就位。</strong><p>在工作区 <code>.env</code> 中设置 <code>OPENAI_API_KEY</code>（或配置的密钥变量）。导入、浏览与编辑仍可使用；生成按钮暂不可用。</p></div><button className="text-link" onClick={() => navigate('config')}>查看配置<ArrowRight size={14} aria-hidden="true" /></button></div>}
          {notice && <div className="notice notice-success" role="status"><span className="success-marker" aria-hidden="true" /><div className="notice-copy">{notice}</div><button className="icon-button" aria-label="关闭操作提示" onClick={() => setNotice(null)}><X size={16} /></button></div>}
          {actionError && !confirmation && <ErrorNotice error={actionError} />}
          {job && <JobPanel key={job.id} job={job} projects={workspace?.projects ?? []} busy={submitting} onCancel={() => { setCancelError(null); setCancelJob(job); }} />}
          {jobError && !workspaceError && <ErrorNotice error={{ ...jobError, message: `任务状态更新失败：${jobError.message}` }} onRetry={refreshData} />}
          {projectError && !workspaceError && !['projects', 'budget', 'config'].includes(view) && <ErrorNotice error={{ ...projectError, message: `作品更新失败：${projectError.message}` }} onRetry={refreshData} />}
          {project && !['projects', 'budget', 'config'].includes(view) && <Warnings warnings={project.warnings} />}
          {content}
          <footer className="main-footer"><span><span className="footer-grid" aria-hidden="true" />页间 · 故事慢慢成书</span><span>本地工作区 / AI 生成内容需审阅</span></footer>
        </main>
      </div>
      {newProjectOpen && <NewProjectDialog onClose={() => setNewProjectOpen(false)} onCreated={(created) => { setNewProjectOpen(false); selectProject(created.id); setNotice(`已创建「${created.title}」，可以导入原稿了。`); refreshData(); }} />}
      {confirmation && <ActionConfirmation input={confirmation} projectTitle={selectedTitle ?? selectedId ?? '当前作品'} budgetSnapshot={budget} busy={submitting} error={actionError} onClose={() => setConfirmation(null)} onConfirm={(input) => { void executeAction(input).then((success) => { if (success) setConfirmation(null); }); }} />}
      {cancelJob && <CancelConfirmation job={cancelJob} busy={submitting} error={cancelError} onClose={() => setCancelJob(null)} onConfirm={() => void cancel()} />}
    </div>
  );
}
