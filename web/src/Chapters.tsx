import { useState } from 'react';
import { ArrowUpRight, BookOpen, ChevronLeft, ChevronRight, CircleAlert, FileDown, Layers3, Play, RotateCcw } from 'lucide-react';
import { fileUrl } from './api';
import { AssetImage, ComicPlaceholder, pretty, RunOptions, StatusBadge } from './components';
import type { ActionProps, Chapter, ProjectDetail } from './types';

export default function Chapters({ project, selectedChapterId, onSelectChapter, busy, canGenerate, onAction }: ActionProps & {
  project: ProjectDetail; selectedChapterId: string | null; onSelectChapter: (id: string) => void;
}) {
  const [pageId, setPageId] = useState<string | null>(null);
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [force, setForce] = useState(false);
  const [ignoreLimit, setIgnoreLimit] = useState(false);
  const chapter = project.chapters.find((item) => item.id === selectedChapterId) ?? project.chapters[0];
  const pages = project.pages.filter((page) => page.chapter_id === chapter?.id).sort((a, b) => a.page_no - b.page_no);
  const visiblePages = flaggedOnly ? pages.filter((page) => page.status === 'flagged') : pages;
  const page = visiblePages.find((item) => item.id === pageId) ?? visiblePages[0];
  const pageIndex = page ? visiblePages.indexOf(page) : -1;

  function selectChapter(item: Chapter) {
    onSelectChapter(item.id); setPageId(null); setFlaggedOnly(false);
  }

  return (
    <div className="chapters-view">
      <div className="page-heading"><div><p className="eyebrow">章节稿台 / CHAPTER DESK</p><h1>一章一章，画下去。</h1><p>已完成的步骤会自动跳过。需要重来时，再明确开启强制执行。</p></div><span className="heading-mark"><BookOpen size={32} strokeWidth={1.2} aria-hidden="true" /></span></div>
      {!chapter ? <div className="empty-state"><BookOpen size={36} strokeWidth={1.2} aria-hidden="true" /><h2>故事目录还是空的。</h2><p>先到创作工作台导入小说，切分好的章节会出现在这里。</p></div> : <div className="chapter-workspace">
        <aside className="chapter-directory" aria-label="小说章节"><div className="directory-heading"><span>原稿目录</span><span>{project.chapters.length} 章</span></div><div className="chapter-directory-list">
          {project.chapters.map((item) => <button type="button" className={`directory-item ${chapter.id === item.id ? 'active' : ''}`} aria-current={chapter.id === item.id ? 'true' : undefined} onClick={() => selectChapter(item)} key={item.id}>
            <span className="directory-index">{String(item.idx).padStart(2, '0')}</span><span className="directory-item-copy"><strong>{item.title || `第 ${item.idx} 章`}</strong><span><StatusBadge status={item.status} /><small>{item.page_count} 页{item.flagged_count > 0 && <span className="flagged-count"> · {item.flagged_count} 待复核</span>}</small></span></span>
          </button>)}
        </div></aside>
        <div className="chapter-desk">
          <section className="chapter-production paper-panel">
            <div className="chapter-title-row"><div><p className="eyebrow">CHAPTER {String(chapter.idx).padStart(2, '0')}</p><h2>{chapter.title || `第 ${chapter.idx} 章`}</h2></div><StatusBadge status={chapter.status} /></div>
            {chapter.summary && <details className="chapter-summary"><summary>本章摘要</summary><p>{chapter.summary}</p></details>}
            <div className="chapter-run-row"><button className="button button-primary" disabled={busy || !canGenerate} onClick={() => onAction({ action: 'run', chapter: chapter.idx, force, ignore_limit: ignoreLimit })}><Play size={16} aria-hidden="true" />制作这一章</button><p>改编 → 生图与审查 → 导出<br /><span>缺少锁定设定或预算不足时，服务端会停止并列出原因。</span></p></div>
            <div className="step-actions" aria-label="单独执行章节步骤">
              <button className="button button-small button-quiet" disabled={busy || !canGenerate} onClick={() => onAction({ action: 'adapt', chapter: chapter.idx, force, ignore_limit: ignoreLimit })}><Layers3 size={15} aria-hidden="true" />改编与分镜</button>
              <button className="button button-small button-quiet" disabled={busy || !canGenerate || !pages.length} onClick={() => onAction({ action: 'render', chapter: chapter.idx, force, ignore_limit: ignoreLimit })}><BookOpen size={15} aria-hidden="true" />绘制画页</button>
              <button className="button button-small button-quiet" disabled={busy || !pages.length} onClick={() => onAction({ action: 'export', chapter: chapter.idx, force })}><FileDown size={15} aria-hidden="true" />导出章节</button>
            </div>
            <RunOptions force={force} ignoreLimit={ignoreLimit} onForce={setForce} onIgnoreLimit={setIgnoreLimit} disabled={busy} />
            {chapter.status === 'exported' && <div className="export-links"><span><CheckMark />本章导出已完成</span>{project.export_options.html && <a href={fileUrl(project.project.id, `chapters/${chapter.id}/export/index.html`)} target="_blank" rel="noreferrer">打开阅读页<ArrowUpRight size={14} aria-hidden="true" /></a>}{project.export_options.pdf && <a href={fileUrl(project.project.id, `chapters/${chapter.id}/export/chapter.pdf`)} download>下载 PDF<FileDown size={14} aria-hidden="true" /></a>}{!project.export_options.html && !project.export_options.pdf && <span>未启用 PDF 或 HTML 输出</span>}</div>}
          </section>
          <section className="page-browser" aria-label="漫画画页">
            <div className="page-browser-heading"><h2>画页<span>{pages.length}</span></h2><label className="checkbox-label"><input type="checkbox" checked={flaggedOnly} onChange={(event) => setFlaggedOnly(event.target.checked)} />只看待复核</label></div>
            {pages.length > 0 && <div className="page-thumbnails" aria-label="选择画页">{visiblePages.map((item) => <button type="button" className={`page-thumbnail ${page?.id === item.id ? 'active' : ''}`} aria-pressed={page?.id === item.id} aria-label={`第 ${String(item.page_no).padStart(2, '0')} 页${item.status === 'flagged' ? '，待复核' : ''}`} key={item.id} onClick={() => setPageId(item.id)}>
              {item.image_url ? <AssetImage src={item.image_url} alt={`第 ${item.page_no} 页缩略图`} /> : <span className="thumbnail-blank" aria-hidden="true"><Layers3 size={16} strokeWidth={1.2} /></span>}<span className="thumbnail-number">{String(item.page_no).padStart(2, '0')}{item.status === 'flagged' && <CircleAlert size={11} aria-hidden="true" />}</span>
            </button>)}</div>}
            {page ? <>
              <div className="page-toolbar"><div><span className="eyebrow">PAGE {String(page.page_no).padStart(2, '0')}</span><StatusBadge status={page.status} /></div><div className="page-navigation"><button type="button" className="icon-button" aria-label="上一页" disabled={pageIndex <= 0} onClick={() => setPageId(visiblePages[pageIndex - 1].id)}><ChevronLeft size={18} /></button><span>{pageIndex + 1} / {visiblePages.length}</span><button type="button" className="icon-button" aria-label="下一页" disabled={pageIndex >= visiblePages.length - 1} onClick={() => setPageId(visiblePages[pageIndex + 1].id)}><ChevronRight size={18} /></button></div></div>
              <div className="page-and-review">
                <div className="reading-desk">{page.image_url ? <a href={page.image_url} target="_blank" rel="noreferrer" aria-label={`在新标签页打开第 ${page.page_no} 页原图`}><AssetImage src={page.image_url} alt={`${project.project.title}，${chapter.title}，第 ${page.page_no} 页漫画`} /></a> : <div className="page-not-rendered"><ComicPlaceholder small /><strong>{page.status === 'flagged' ? '本页被标记，暂无可用图像。' : '分镜已在，画面还在路上。'}</strong><p>{page.status === 'flagged' ? '查看审查详情，或添加修正要求后重新绘制。' : '运行「绘制画页」后，真实漫画会出现在这里。'}</p></div>}</div>
                <aside className="review-inspector">
                  <p className="eyebrow">画页记录</p><h3>第 {page.page_no} 页</h3><code className="page-id">{page.id}</code>
                  {page.status === 'flagged' && <div className="page-flag-warning"><CircleAlert size={17} aria-hidden="true" /><p>这页未通过全部审查。导出不会自动隐藏它，请先阅读审查记录。</p></div>}
                  <button className="button button-small button-ink redo-button" disabled={busy || !canGenerate} onClick={() => onAction({ action: 'redo', page_id: page.id })}><RotateCcw size={14} aria-hidden="true" />重绘这一页</button>
                  <p className="field-help">重绘会再次计费。旧尝试保留，当前页可能被新结果替换。</p>
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

function CheckMark() {
  return <span className="export-check" aria-hidden="true">✓</span>;
}
