import { useState, type FormEvent } from 'react';
import { ArrowUpRight, Check, LockKeyhole, Palette, Plus } from 'lucide-react';
import { AssetImage, Dialog, pretty, RunOptions, StatusBadge } from './components';
import type { ActionProps, Entity, ProjectDetail, Reference, RefKind } from './types';

const kinds: { id: RefKind; label: string; description: string }[] = [
  { id: 'style', label: '全书画风', description: '一本书的线条、色彩与气氛，从这里定下来。' },
  { id: 'outfit', label: '角色服装', description: '统一角色外貌与服装配色，跨章节保持同一个模样。' },
  { id: 'location', label: '故事地点', description: '给故事中的场景建立稳定的空间与色彩基准。' },
];

export default function References({ project, busy, canGenerate, onAction }: ActionProps & { project: ProjectDetail }) {
  const [kind, setKind] = useState<RefKind>('style');
  const [target, setTarget] = useState('');
  const [status, setStatus] = useState('all');
  const [force, setForce] = useState(false);
  const [ignoreLimit, setIgnoreLimit] = useState(false);
  const [preview, setPreview] = useState<Reference | null>(null);
  const selectedKind = kinds.find((item) => item.id === kind)!;
  const targets = kind === 'outfit' ? project.outfits : kind === 'location' ? project.locations : [];
  const lockedTargets = new Set(project.refs.filter((ref) => ref.status === 'locked').map((ref) => `${ref.kind}:${ref.target_id}`));
  const styleLocked = project.refs.some((ref) => ref.kind === 'style' && ref.status === 'locked');
  const selectedTargetLocked = kind === 'style' ? styleLocked : Boolean(target && lockedTargets.has(`${kind}:${target}`));
  const visibleRefs = project.refs.filter((ref) => ref.kind === kind && (status === 'all' || ref.status === status) && (!target || ref.target_id === target));

  function targetName(refKind: RefKind, id: string): string {
    if (refKind === 'style') return '全书画风';
    const entity = (refKind === 'outfit' ? project.outfits : project.locations).find((item) => item.id === id);
    if (refKind === 'outfit') {
      const characterId = entity?.character_id ?? id.split('.')[0];
      const character = project.characters.find((item) => item.id === characterId);
      return `${character?.name ?? characterId} · ${entity?.name ?? id}`;
    }
    return entity?.name ?? id;
  }

  function generate(event: FormEvent) {
    event.preventDefault();
    onAction({ action: 'refs', kind, ...(target ? { target } : {}), force, ignore_limit: ignoreLimit });
  }

  return (
    <div className="refs-view">
      <div className="page-heading"><div><p className="eyebrow">视觉设定 / REFERENCE ATLAS</p><h1>给故事，定下模样。</h1><p>先锁定画风，再为角色服装和地点选图。锁定是确定，而不是收藏。</p></div><span className="heading-mark"><Palette size={31} strokeWidth={1.2} aria-hidden="true" /></span></div>
      <div className="kind-tabs" role="tablist" aria-label="参考图类型">
        {kinds.map((item, index) => <button type="button" role="tab" id={`ref-tab-${item.id}`} aria-selected={kind === item.id} aria-controls="reference-content" className={kind === item.id ? 'active' : ''} key={item.id}
          onClick={() => { setKind(item.id); setTarget(''); }}><span className="kind-index">0{index + 1}</span>{item.label}<span className="count-label">{project.refs.filter((ref) => ref.kind === item.id).length}</span></button>)}
      </div>
      <section id="reference-content" role="tabpanel" aria-labelledby={`ref-tab-${kind}`}>
        <form className="reference-generator paper-panel" onSubmit={generate}>
          <div className="generator-copy"><h2>{selectedKind.label}</h2><p>{selectedKind.description}</p>{kind === 'style' && project.project.style_desc && <p className="style-description">{project.project.style_desc}</p>}</div>
          <div className="generator-controls">
            {kind !== 'style' && <label className="field"><span>指定对象 <small>可选</small></span><select value={target} onChange={(event) => setTarget(event.target.value)} disabled={busy}><option value="">所有未锁定的{kind === 'outfit' ? '服装' : '地点'}</option>{targets.map((item) => <option value={item.id} key={item.id}>{targetName(kind, item.id)} · {item.id}</option>)}</select></label>}
            <button className="button button-primary" type="submit" disabled={busy || !canGenerate('refs') || selectedTargetLocked || (kind !== 'style' && !styleLocked)}><Plus size={16} aria-hidden="true" />{selectedTargetLocked ? '设定已锁定' : '生成参考图候选'}</button>
          </div>
          {kind !== 'style' && !styleLocked && <p className="generator-hint">请先在「全书画风」中生成并锁定一张画风图，再生成其他设定。</p>}
          {selectedTargetLocked && <p className="generator-hint">这个对象已锁定。已有设定不能重新锁定或替换，也不会因强制执行而解除锁定。</p>}
          <RunOptions force={force} ignoreLimit={ignoreLimit} onForce={setForce} onIgnoreLimit={setIgnoreLimit} disabled={busy} />
        </form>
        <div className="atlas-toolbar"><span>{visibleRefs.length} 张参考图{target && ` · ${targetName(kind, target)}`}</span><label className="inline-select"><span className="sr-only">按参考图状态筛选</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">全部状态</option><option value="candidate">待选择</option><option value="locked">已锁定</option><option value="rejected">未选用</option></select></label></div>
        {visibleRefs.length ? <div className="reference-grid">
          {visibleRefs.map((ref) => {
            const groupLocked = lockedTargets.has(`${ref.kind}:${ref.target_id}`);
            return <article className={`reference-card ${ref.status === 'locked' ? 'reference-locked' : ''}`} key={ref.id}>
              <button className="reference-image" type="button" onClick={() => setPreview(ref)} disabled={!ref.image_url} aria-label={`预览${targetName(ref.kind, ref.target_id)}参考图 ${ref.id}`}>
                <AssetImage src={ref.image_url} alt={`${targetName(ref.kind, ref.target_id)}参考图候选 ${ref.id}`} />
                {ref.status === 'locked' && <span className="image-lock"><LockKeyhole size={13} aria-hidden="true" />已锁定</span>}
                <span className="image-expand"><ArrowUpRight size={17} aria-hidden="true" /></span>
              </button>
              <div className="reference-copy"><h3>{targetName(ref.kind, ref.target_id)}</h3><code title={ref.id}>{ref.id}</code><div className="reference-card-footer"><StatusBadge status={ref.status} /><button className="button button-small button-quiet" disabled={busy || ref.status !== 'candidate' || groupLocked}
                title={groupLocked && ref.status !== 'locked' ? '同一对象已有锁定参考图，不能替换' : undefined} onClick={() => onAction({ action: 'lock', ref_id: ref.id })}>{ref.status === 'locked' ? <Check size={14} aria-hidden="true" /> : <LockKeyhole size={14} aria-hidden="true" />}{ref.status === 'locked' ? '已确定' : ref.status === 'rejected' ? '未选用' : groupLocked ? '对象已锁定' : '选定并锁定'}</button></div></div>
            </article>;
          })}
        </div> : <div className="atlas-empty"><div className="empty-atlas-mark" aria-hidden="true"><Palette size={34} strokeWidth={1.2} /></div><h2>{status === 'all' && !target ? '画面还没来，设定先留白。' : '这里还没有符合筛选的参考图。'}</h2><p>{status === 'all' && !target ? '生成真实候选后，它们会出现在这里。挑选前可以放大查看，锁定后将用于后续制作。' : '切换状态或指定对象，查看其他参考图。'}</p><span className="eyebrow">不预置素材 · 不模拟生成结果</span></div>}
      </section>
      <details className="bible-panel"><summary><FileIcon />查看文字设定集<span>{project.characters.length} 位角色 · {project.outfits.length} 套服装 · {project.locations.length} 处地点</span></summary>
        {!project.characters.length && !project.outfits.length && !project.locations.length && <p className="section-description">全书预处理完成后，角色、服装与地点设定会显示在这里。</p>}
        <div className="bible-grid">{([{ name: '角色', entities: project.characters }, { name: '服装', entities: project.outfits }, { name: '地点', entities: project.locations }] satisfies { name: string; entities: Entity[] }[]).map((group) => group.entities.map((entity) => <details className="entity-detail" key={`${group.name}:${entity.id}`}><summary><span>{group.name}</span><strong>{entity.name ?? entity.id}</strong></summary><pre>{pretty(entity)}</pre></details>))}</div>
      </details>
      {preview && <Dialog title={targetName(preview.kind, preview.target_id)} eyebrow="参考图原图" className="image-dialog" onClose={() => setPreview(null)}>
        <AssetImage src={preview.image_url} alt={`${targetName(preview.kind, preview.target_id)}原始参考图`} />
        <div className="image-dialog-footer"><div><StatusBadge status={preview.status} /><code>{preview.path}</code></div>{preview.image_url && <a className="button button-small button-quiet" href={preview.image_url} target="_blank" rel="noreferrer">打开原图<ArrowUpRight size={15} aria-hidden="true" /></a>}</div>
      </Dialog>}
    </div>
  );
}

function FileIcon() {
  return <span className="bible-icon" aria-hidden="true">文</span>;
}
