import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, ImageOff, LoaderCircle, RefreshCw, X } from 'lucide-react';
import type { ApiProblem } from './types';

export const actionNames: Record<string, string> = {
  prepare: '全书预处理', refs: '参考图生成', lock: '锁定设定', adapt: '章节改编',
  render: '画页生成', run: '整章制作', export: '章节导出', redo: '单页重绘',
};

export const sourceNames: Record<string, string> = {
  repository: '仓库默认', workspace: '工作区覆盖', project: '本项目覆盖',
};

const statuses: Record<string, [string, string]> = {
  imported: ['已导入', 'muted'], adapted: ['已改编', 'blue'], storyboarded: ['分镜就绪', 'blue'],
  rendered: ['已绘制', 'teal'], exported: ['已导出', 'teal'], planned: ['待绘制', 'muted'],
  generating: ['绘制中', 'blue'], passed: ['已通过', 'teal'], flagged: ['待复核', 'orange'],
  candidate: ['待选择', 'muted'], locked: ['已锁定', 'teal'], rejected: ['未选用', 'muted'],
  running: ['进行中', 'blue'], completed: ['已完成', 'teal'], failed: ['失败', 'orange'], cancelled: ['已取消', 'muted'],
};

export function StatusBadge({ status }: { status: string }) {
  const [label, tone] = statuses[status] ?? [status, 'muted'];
  return <span className={`status status-${tone}`}><span aria-hidden="true" />{label}</span>;
}

export function Loading({ children = '正在读取本地工作区' }: { children?: ReactNode }) {
  return <div className="loading" role="status"><LoaderCircle className="spin" size={18} aria-hidden="true" />{children}</div>;
}

export function ErrorNotice({ error, onRetry }: { error: ApiProblem; onRetry?: () => void }) {
  return (
    <div className="notice notice-error" role="alert">
      <CircleAlert size={19} aria-hidden="true" />
      <div className="notice-copy">
        <strong>{error.message}</strong>
        {error.code && <span className="error-code">{error.code}</span>}
        {error.details !== undefined && <details><summary>查看错误详情</summary><pre>{pretty(error.details)}</pre></details>}
      </div>
      {onRetry && <button type="button" className="button button-small button-quiet" onClick={onRetry}><RefreshCw size={14} aria-hidden="true" />重试</button>}
    </div>
  );
}

export function Warnings({ warnings, title = '制作提醒' }: { warnings: string[]; title?: string }) {
  if (!warnings.length) return null;
  return (
    <details className="warnings">
      <summary><CircleAlert size={16} aria-hidden="true" />{title}<span>{warnings.length}</span></summary>
      <ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
    </details>
  );
}

export function Dialog({ title, eyebrow, children, onClose, busy = false, className = '' }: {
  title: string; eyebrow?: string; children: ReactNode; onClose: () => void; busy?: boolean; className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = 'dialog-heading';
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    const input = dialog.querySelector<HTMLElement>('[autofocus]') ?? dialog.querySelector<HTMLElement>('form input, form textarea, form select');
    input?.focus();
    return () => dialog.close();
  }, []);
  return (
    <dialog ref={ref} className={`dialog ${className}`} aria-labelledby={headingId}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
      <div className="dialog-heading">
        <div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2 id={headingId}>{title}</h2></div>
        <button className="icon-button" type="button" aria-label="关闭对话框" onClick={onClose} disabled={busy}><X size={21} /></button>
      </div>
      {children}
    </dialog>
  );
}

export function AssetImage({ src, alt, className = '' }: { src: string | null; alt: string; className?: string }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  if (!src || src === failedSource) {
    return <div className={`asset-unavailable ${className}`}><ImageOff size={25} aria-hidden="true" /><span>{src ? '图片暂不可用' : '尚无图片'}</span></div>;
  }
  return <img className={className} src={src} alt={alt} loading="lazy" onError={() => setFailedSource(src)} />;
}

export function ComicPlaceholder({ small = false }: { small?: boolean }) {
  return (
    <div className={`comic-placeholder ${small ? 'comic-placeholder-small' : ''}`} aria-label="漫画分格示意，尚未生成作品">
      <div className="placeholder-page">
        <span className="placeholder-registration">PAGE / 未绘制</span>
        <div className="placeholder-panels" aria-hidden="true">
          <div className="placeholder-panel panel-wide"><span className="placeholder-sun" /><span className="placeholder-hill hill-one" /><span className="placeholder-hill hill-two" /></div>
          <div className="placeholder-panel"><span className="placeholder-bubble" /><span className="placeholder-lines" /></div>
          <div className="placeholder-panel panel-ink"><span className="placeholder-star" /></div>
          <div className="placeholder-panel panel-bottom"><span className="placeholder-horizon" /><span className="placeholder-caption" /></div>
        </div>
        <span className="placeholder-footer">留白，等一个好故事。</span>
      </div>
      {!small && <span className="placeholder-note">分格示意 · 不是生成作品</span>}
    </div>
  );
}

export function RunOptions({ force, ignoreLimit, onForce, onIgnoreLimit, disabled = false }: {
  force: boolean; ignoreLimit: boolean; onForce: (value: boolean) => void; onIgnoreLimit: (value: boolean) => void; disabled?: boolean;
}) {
  return (
    <details className="run-options">
      <summary>更多执行选项{(force || ignoreLimit) && <span className="options-active">已启用</span>}</summary>
      <label className="checkbox-label"><input type="checkbox" checked={force} onChange={(event) => onForce(event.target.checked)} disabled={disabled} />强制重新执行已完成步骤</label>
      <label className="checkbox-label"><input type="checkbox" checked={ignoreLimit} onChange={(event) => onIgnoreLimit(event.target.checked)} disabled={disabled} />仅本次忽略预算上限</label>
      <p className="field-help">这些选项可能增加花费，执行前会再次确认；不会解除参考图锁定。</p>
    </details>
  );
}

export function pretty(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
}

export function money(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
}

export function dateTime(value?: string | null): string {
  if (!value) return '未提供';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
