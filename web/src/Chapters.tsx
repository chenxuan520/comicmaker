import { useEffect, useState } from 'react';
import { ArrowUpRight, BookOpen, ChevronLeft, ChevronRight, CircleAlert, FileDown, Layers3, Play, RotateCcw } from 'lucide-react';
import { parseDocument } from 'yaml';
import { fileUrl, problem, request, send } from './api';
import { AssetImage, ComicPlaceholder, ErrorNotice, pretty, RunOptions, StatusBadge } from './components';
import type { ActionProps, ApiProblem, Chapter, ComicFormat, ComicPage, ConfigDocument, ProjectDetail } from './types';

const formatNames: Record<ComicFormat, string> = { page: '页漫', strip: '手机条漫' };

export default function Chapters({ project, selectedChapterId, onSelectChapter, onUpdated, busy, canGenerate, onAction }: ActionProps & {
  project: ProjectDetail; selectedChapterId: string | null; onSelectChapter: (id: string) => void; onUpdated: () => void;
}) {
  const [pageId, setPageId] = useState<string | null>(null);
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [continuous, setContinuous] = useState(false);
  const [format, setFormat] = useState<ComicFormat>(project.comic_format);
  const [savingFormat, setSavingFormat] = useState(false);
  const [formatSaved, setFormatSaved] = useState(false);
  const [formatError, setFormatError] = useState<ApiProblem | null>(null);
  const [force, setForce] = useState(false);
  const [ignoreLimit, setIgnoreLimit] = useState(false);
  const chapter = project.chapters.find((item) => item.id === selectedChapterId) ?? project.chapters[0];
  const pages = project.pages.filter((page) => page.chapter_id === chapter?.id).sort((a, b) => a.page_no - b.page_no);
  const visiblePages = flaggedOnly && !continuous ? pages.filter((page) => page.status === 'flagged') : pages;
  const page = visiblePages.find((item) => item.id === pageId) ?? visiblePages[0];
  const pageIndex = page ? visiblePages.indexOf(page) : -1;

  useEffect(() => { setFormat(project.comic_format); }, [project.comic_format]);

  async function saveFormat(nextFormat: ComicFormat) {
    setSavingFormat(true); setFormatError(null); setFormatSaved(false);
    try {
      const path = `/api/config?project=${encodeURIComponent(project.project.id)}`;
      const current = await request<ConfigDocument>(path);
      const document = parseDocument(current.yaml);
      document.setIn(['storyboard', 'format'], nextFormat);
      await send<ConfigDocument>(path, 'PUT', { yaml: document.toString() });
      setFormat(nextFormat); setFormatSaved(true); onUpdated();
    } catch (cause) { setFormatError(problem(cause)); }
    finally { setSavingFormat(false); }
  }

  function selectChapter(item: Chapter) {
    onSelectChapter(item.id); setPageId(null); setFlaggedOnly(false);
  }

  return (
    <div className="chapters-view">
      <div className="page-heading"><div><p className="eyebrow">章节稿台 / CHAPTER DESK</p><h1>一章一章，画下去。</h1><p>已完成的步骤会自动跳过。需要重来时，再明确开启强制执行。</p></div><span className="heading-mark"><BookOpen size={32} strokeWidth={1.2} aria-hidden="true" /></span></div>
      <section className="comic-format-panel paper-panel" aria-labelledby="comic-format-heading" aria-busy={savingFormat}>
        <div className="section-heading"><div><p className="eyebrow">仅当前作品 / COMIC FORMAT</p><h2 id="comic-format-heading">新分镜格式</h2></div><div className="segmented" role="group" aria-labelledby="comic-format-heading" aria-describedby="comic-format-help"><button type="button" className={format === 'page' ? 'active' : ''} aria-pressed={format === 'page'} disabled={busy || savingFormat} onClick={() => void saveFormat('page')}>页漫</button><button type="button" className={format === 'strip' ? 'active' : ''} aria-pressed={format === 'strip'} disabled={busy || savingFormat} onClick={() => void saveFormat('strip')}>手机条漫</button></div></div>
        <p className="section-description" id="comic-format-help">手机条漫为单列四格：每组 4 个横向全宽画格，从上到下排列。</p>
        <p className="field-help">只保存本项目覆盖，不影响工作区其他作品；切换本身不计费，不会自动删除、重绘或启动任务。现有分镜与图片不会自动转为条漫。</p>
        <p className="field-help">旧章改成新格式需要明确强制改编：在「更多执行选项」勾选强制重新执行，再运行「改编与分镜」或「制作这一章」。重新改编与绘制会再次计费，历史原图保留。</p>
        {savingFormat && <p className="field-help" role="status">正在保存本项目格式…</p>}
        {formatSaved && <p className="save-confirmation" role="status">本项目格式已保存；没有启动生成任务。</p>}
        {formatError && <ErrorNotice error={formatError} />}
      </section>
      {!chapter ? <div className="empty-state"><BookOpen size={36} strokeWidth={1.2} aria-hidden="true" /><h2>故事目录还是空的。</h2><p>先到创作工作台导入小说，切分好的章节会出现在这里。</p></div> : <div className="chapter-workspace">
        <aside className="chapter-directory" aria-label="小说章节"><div className="directory-heading"><span>原稿目录</span><span>{project.chapters.length} 章</span></div><div className="chapter-directory-list">
          {project.chapters.map((item) => <button type="button" className={`directory-item ${chapter.id === item.id ? 'active' : ''}`} aria-current={chapter.id === item.id ? 'true' : undefined} onClick={() => selectChapter(item)} key={item.id}>
            <span className="directory-index">{String(item.idx).padStart(2, '0')}</span><span className="directory-item-copy"><strong>{item.title || `第 ${item.idx} 章`}</strong><span><StatusBadge status={item.status} /><small>{item.page_count} 页 / 组{item.flagged_count > 0 && <span className="flagged-count"> · {item.flagged_count} 待复核</span>}</small></span></span>
          </button>)}
        </div></aside>
        <div className="chapter-desk">
          <section className="chapter-production paper-panel">
            <div className="chapter-title-row"><div><p className="eyebrow">CHAPTER {String(chapter.idx).padStart(2, '0')}</p><h2>{chapter.title || `第 ${chapter.idx} 章`}</h2></div><StatusBadge status={chapter.status} /></div>
            {chapter.summary && <details className="chapter-summary"><summary>本章摘要</summary><p>{chapter.summary}</p></details>}
            <div className="chapter-run-row"><button className="button button-primary" disabled={busy || savingFormat || !canGenerate('run')} onClick={() => onAction({ action: 'run', chapter: chapter.idx, force, ignore_limit: ignoreLimit })}><Play size={16} aria-hidden="true" />制作这一章</button><p>改编 → 生图与审查 → 导出<br /><span>缺少锁定设定或预算不足时，服务端会停止并列出原因。</span></p></div>
            <div className="step-actions" aria-label="单独执行章节步骤">
              <button className="button button-small button-quiet" disabled={busy || savingFormat || !canGenerate('adapt')} onClick={() => onAction({ action: 'adapt', chapter: chapter.idx, force, ignore_limit: ignoreLimit })}><Layers3 size={15} aria-hidden="true" />改编与分镜</button>
              <button className="button button-small button-quiet" disabled={busy || savingFormat || !canGenerate('render') || !pages.length} onClick={() => onAction({ action: 'render', chapter: chapter.idx, force, ignore_limit: ignoreLimit })}><BookOpen size={15} aria-hidden="true" />绘制画页</button>
              <button className="button button-small button-quiet" disabled={busy || savingFormat || !pages.length} onClick={() => onAction({ action: 'export', chapter: chapter.idx, force })}><FileDown size={15} aria-hidden="true" />导出章节</button>
            </div>
            <RunOptions force={force} ignoreLimit={ignoreLimit} onForce={setForce} onIgnoreLimit={setIgnoreLimit} disabled={busy || savingFormat} />
            {chapter.status === 'exported' && <div className="export-links"><span><CheckMark />本章导出已完成</span>{project.export_options.html && <a href={fileUrl(project.project.id, `chapters/${chapter.id}/export/index.html`)} target="_blank" rel="noreferrer">打开阅读页<ArrowUpRight size={14} aria-hidden="true" /></a>}{project.export_options.pdf && <a href={fileUrl(project.project.id, `chapters/${chapter.id}/export/chapter.pdf`)} download>下载 PDF<FileDown size={14} aria-hidden="true" /></a>}{!project.export_options.html && !project.export_options.pdf && <span>未启用 PDF 或 HTML 输出</span>}</div>}
          </section>
          <section className="page-browser" aria-label="漫画画页与条漫组">
            <div className="page-browser-heading"><h2>画页 / 条漫组<span>{pages.length}</span></h2><div className="page-browser-controls"><div className="segmented reading-mode" role="group" aria-label="阅读显示方式"><button type="button" className={!continuous ? 'active' : ''} aria-pressed={!continuous} onClick={() => setContinuous(false)}>逐页查看</button><button type="button" className={continuous ? 'active' : ''} aria-pressed={continuous} onClick={() => { setContinuous(true); setFlaggedOnly(false); }}>向下连读</button></div><label className="checkbox-label"><input type="checkbox" checked={flaggedOnly} disabled={continuous} onChange={(event) => setFlaggedOnly(event.target.checked)} />只看待复核</label></div></div>
            {continuous && <p className="field-help reading-help">按页码顺序展示本章全部画页与条漫组，待绘制和待复核也保留。点击图片选择记录，点「分镜与审查」跳到详情；连读只改变显示，不转换原图。</p>}
            {pages.length > 0 && !continuous && <div className="page-thumbnails" aria-label="选择画页或条漫组">{visiblePages.map((item) => <button type="button" className={`page-thumbnail ${item.format === 'strip' ? 'page-thumbnail-strip' : ''} ${page?.id === item.id ? 'active' : ''}`} aria-pressed={page?.id === item.id} aria-label={`${pageLabel(item)}，${formatNames[item.format]}${item.status === 'flagged' ? '，待复核' : ''}`} key={item.id} onClick={() => setPageId(item.id)}>
              {item.image_url ? <AssetImage src={item.image_url} alt={`${pageLabel(item)}缩略图`} /> : <span className="thumbnail-blank" aria-hidden="true"><Layers3 size={16} strokeWidth={1.2} /></span>}<span className="thumbnail-number">{String(item.page_no).padStart(2, '0')}{item.status === 'flagged' && <CircleAlert size={11} aria-hidden="true" />}</span>
            </button>)}</div>}
            {page ? <>
              <div className="page-toolbar"><div><span className="eyebrow">{page.format === 'strip' ? 'GROUP' : 'PAGE'} {String(page.page_no).padStart(2, '0')}</span><span className="page-format">{formatNames[page.format]}{page.format === 'strip' && ' · 单列四格'}</span><StatusBadge status={page.status} /></div><div className="page-navigation"><button type="button" className="icon-button" aria-label="上一页或条漫组" disabled={pageIndex <= 0} onClick={() => setPageId(visiblePages[pageIndex - 1].id)}><ChevronLeft size={18} /></button><span>{pageIndex + 1} / {visiblePages.length}</span><button type="button" className="icon-button" aria-label="下一页或条漫组" disabled={pageIndex >= visiblePages.length - 1} onClick={() => setPageId(visiblePages[pageIndex + 1].id)}><ChevronRight size={18} /></button></div></div>
              <div className="page-and-review">
                {continuous ? <div className="continuous-reader" aria-label="本章向下连读">{pages.map((item) => <article className={`continuous-page ${page.id === item.id ? 'active' : ''}`} key={item.id} aria-label={`${pageLabel(item)}，${formatNames[item.format]}`}>
                  <div className="continuous-page-heading"><div><strong>{pageLabel(item)}</strong><span className="page-format">{formatNames[item.format]}{item.format === 'strip' && ' · 单列四格'}</span><StatusBadge status={item.status} /></div><a className="text-link" href="#page-review" aria-label={`查看${pageLabel(item)}的分镜与审查`} onClick={() => setPageId(item.id)}>分镜与审查<ArrowUpRight size={14} aria-hidden="true" /></a></div>
                  {item.image_url ? <button type="button" className="continuous-image" aria-label={`选择${pageLabel(item)}的审查记录`} aria-pressed={page.id === item.id} aria-controls="page-review" onClick={() => setPageId(item.id)}><AssetImage src={item.image_url} alt={`${project.project.title}，${chapter.title}，${pageLabel(item)}${formatNames[item.format]}`} /></button> : <div className="page-not-rendered"><strong>{item.status === 'flagged' ? `${pageLabel(item)}被标记，暂无可用图像。` : '分镜已保存，尚未绘制。'}</strong><p>{item.status === 'flagged' ? '请查看分镜与审查记录，再决定是否重绘。' : '运行「绘制画页」后，真实漫画会显示在这里。'}</p></div>}
                  {item.status === 'flagged' && <div className="page-flag-warning"><CircleAlert size={17} aria-hidden="true" /><p>未通过全部审查，仍保留展示。请先查看审查记录。</p></div>}
                </article>)}</div> : <div className={`reading-desk ${page.format === 'strip' ? 'reading-desk-strip' : ''}`}>{page.image_url ? <a href={page.original_image_url!} target="_blank" rel="noreferrer" aria-label={`在新标签页打开${pageLabel(page)}原图`}><AssetImage src={page.image_url} alt={`${project.project.title}，${chapter.title}，${pageLabel(page)}${formatNames[page.format]}`} /></a> : <div className="page-not-rendered">{page.format === 'page' && <ComicPlaceholder small />}<strong>{page.status === 'flagged' ? `${pageLabel(page)}被标记，暂无可用图像。` : '分镜已在，画面还在路上。'}</strong><p>{page.status === 'flagged' ? '查看审查详情，或添加修正要求后重新绘制。' : '运行「绘制画页」后，真实漫画会出现在这里。'}</p></div>}</div>}
                <aside id="page-review" className={`review-inspector ${continuous ? 'continuous-review' : ''}`} aria-label={`${pageLabel(page)}分镜与审查记录`} tabIndex={-1}>
                  <p className="eyebrow">{page.format === 'strip' ? '条漫组记录' : '画页记录'}</p><h3>{pageLabel(page)}</h3><code className="page-id">{page.id}</code>
                  {page.status === 'flagged' && <div className="page-flag-warning"><CircleAlert size={17} aria-hidden="true" /><p>{pageLabel(page)}未通过全部审查。导出不会自动隐藏它，请先阅读审查记录。</p></div>}
                  {continuous && page.image_url && <a className="text-link" href={page.original_image_url!} target="_blank" rel="noreferrer">打开选定原图<ArrowUpRight size={14} aria-hidden="true" /></a>}
                  <button className="button button-small button-ink redo-button" disabled={busy || savingFormat || !canGenerate('redo')} onClick={() => onAction({ action: 'redo', page_id: page.id })}><RotateCcw size={14} aria-hidden="true" />{page.format === 'strip' ? '重绘这一组' : '重绘这一页'}</button>
                  <p className="field-help">重绘会再次计费。历史原图保留，当前选定图可能被新结果替换。</p>
                  <details className="inspector-detail"><summary>分镜原文</summary><pre>{pretty(page.storyboard)}</pre></details>
                  <div className="review-records"><h4>审查记录 <span>{page.reviews?.length ?? 0}</span></h4>{page.reviews?.length ? page.reviews.map((review, index) => <details className="inspector-detail" key={index}><summary>审查 {index + 1}{review.attempt_id === page.final_attempt_id ? ' · 当前选定' : ''}</summary><pre>{pretty(review)}</pre></details>) : <p className="field-help">服务端尚未提供审查记录。</p>}</div>
                  {page.final_attempt_id && <div className="attempt-record"><span>当前选定尝试</span><code>{page.final_attempt_id}</code></div>}
                </aside>
              </div>
            </> : <div className="empty-pages"><ComicPlaceholder small /><div><p className="eyebrow">下一页，尚未落笔</p><h2>{flaggedOnly ? '没有待复核的画页。' : '先把故事，拆成分镜。'}</h2><p>{flaggedOnly ? '切换到全部画页，继续浏览这一章。' : '单独运行「改编与分镜」，或直接制作这一章。没有真实结果前，这里保持留白。'}</p></div></div>}
          </section>
        </div>
      </div>}
    </div>
  );
}

function pageLabel(page: ComicPage) {
  return `第 ${page.page_no} ${page.format === 'strip' ? '组' : '页'}`;
}

function CheckMark() {
  return <span className="export-check" aria-hidden="true">✓</span>;
}
