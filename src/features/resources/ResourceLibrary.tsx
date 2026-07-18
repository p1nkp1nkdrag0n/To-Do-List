import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Archive,
  ArchiveRestore,
  Check,
  Download,
  File,
  FileCode2,
  FilePlus2,
  FileText,
  Filter,
  History,
  LoaderCircle,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Tags,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";

import { Modal } from "../../components/Modal";
import { api, errorMessage } from "../../lib/api";
import type {
  ResourceDetail,
  ResourceEntity,
  ResourceListItem,
  ResourceVersionEntity,
  Schedule,
  TagEntity,
} from "../../types";

interface ResourceLibraryProps {
  projectId: string;
  online: boolean;
  invalidationVersion: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
}

function ResourceIcon({ kind, mimeType }: { kind: "markdown" | "file"; mimeType?: string }) {
  if (kind === "markdown") return <FileCode2 size={19} />;
  if (mimeType?.includes("pdf")) return <FileText size={19} />;
  return <File size={19} />;
}

export function ResourceLibrary({ projectId, online, invalidationVersion }: ResourceLibraryProps) {
  const [resources, setResources] = useState<ResourceListItem[]>([]);
  const [tags, setTags] = useState<TagEntity[]>([]);
  const [schedule, setSchedule] = useState<Schedule>();
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<ResourceDetail>();
  const [search, setSearch] = useState("");
  const [phaseId, setPhaseId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [tagId, setTagId] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [trashMode, setTrashMode] = useState(false);
  const [showCreate, setShowCreate] = useState<"markdown" | "file">();
  const [showVersion, setShowVersion] = useState(false);
  const [showTags, setShowTags] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const resourceRequestId = useRef(0);

  const loadResources = useCallback(async () => {
    const requestId = ++resourceRequestId.current;
    const path = trashMode
      ? `/api/projects/${projectId}/trash/resources`
      : `/api/projects/${projectId}/resources?includeArchived=${includeArchived}`;
    const result = await api.get<{ resources: ResourceListItem[] }>(path);
    if (requestId !== resourceRequestId.current) return result.resources;
    setResources(result.resources);
    if (selectedId && !result.resources.some((resource) => resource.id === selectedId)) {
      setSelectedId(undefined);
      setDetail(undefined);
    }
    return result.resources;
  }, [includeArchived, projectId, selectedId, trashMode]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [tagResult, scheduleResult] = await Promise.all([
        api.get<{ tags: TagEntity[] }>(`/api/projects/${projectId}/tags`),
        api.get<Schedule>(`/api/projects/${projectId}/schedule`),
      ]);
      setTags(tagResult.tags);
      setSchedule(scheduleResult);
      await loadResources();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [loadResources, projectId]);

  useEffect(() => { setSelectedId(undefined); setDetail(undefined); void loadAll(); }, [projectId]);
  useEffect(() => { void loadResources().catch((caught) => setError(errorMessage(caught))); }, [includeArchived, trashMode]);
  useEffect(() => {
    if (invalidationVersion > 0) void loadAll();
  }, [invalidationVersion]);
  useEffect(() => {
    if (!selectedId) { setDetail(undefined); return; }
    let cancelled = false;
    const path = trashMode
      ? `/api/projects/${projectId}/trash/resources/${selectedId}`
      : `/api/projects/${projectId}/resources/${selectedId}`;
    void api.get<ResourceDetail>(path)
      .then((result) => { if (!cancelled) setDetail(result); })
      .catch((caught) => { if (!cancelled) setError(errorMessage(caught)); });
    return () => { cancelled = true; };
  }, [projectId, selectedId, trashMode]);

  const visibleResources = useMemo(() => resources.filter((resource) => {
    const query = search.trim().toLocaleLowerCase();
    if (query && !resource.title.toLocaleLowerCase().includes(query)) return false;
    if (phaseId && resource.phaseId !== phaseId) return false;
    if (taskId && resource.sourceTaskId !== taskId) return false;
    if (tagId && !resource.tags.some((tag) => tag.id === tagId)) return false;
    return true;
  }), [phaseId, resources, search, tagId, taskId]);

  const refreshSelected = async () => {
    const nextResources = await loadResources();
    if (!selectedId || !nextResources?.some((resource) => resource.id === selectedId)) {
      setSelectedId(undefined);
      setDetail(undefined);
      return;
    }
    const path = trashMode
      ? `/api/projects/${projectId}/trash/resources/${selectedId}`
      : `/api/projects/${projectId}/resources/${selectedId}`;
    setDetail(await api.get<ResourceDetail>(path));
  };

  const phaseName = (id: string | null) => schedule?.phases.find((phase) => phase.id === id)?.name ?? "—";
  const taskName = (id: string | null) => schedule?.tasks.find((task) => task.id === id)?.title ?? "—";
  return (
    <div className={`resource-view ${detail ? "with-drawer" : ""}`}>
      <section className="resource-workarea">
        <header className="resource-heading">
          <div><h1>{trashMode ? "资料回收站" : "资料库"}</h1><span>共 {visibleResources.length} 项资源</span></div>
          <div>
            <button className="secondary-button" type="button" onClick={() => setShowTags(true)}><Tags size={16} />标签</button>
            <button className="secondary-button" type="button" onClick={() => setShowCreate("file")} disabled={!online || trashMode}><Upload size={16} />上传文件</button>
            <button className="primary-button" type="button" onClick={() => setShowCreate("markdown")} disabled={!online || trashMode}><FilePlus2 size={16} />新建 Markdown</button>
          </div>
        </header>
        <div className="resource-filters">
          <label className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索资源名称" /></label>
          <label><Filter size={14} /><select value={phaseId} onChange={(event) => setPhaseId(event.target.value)}><option value="">阶段：全部</option>{schedule?.phases.map((phase) => <option key={phase.id} value={phase.id}>{phase.name}</option>)}</select></label>
          <label><select value={taskId} onChange={(event) => setTaskId(event.target.value)}><option value="">来源任务：全部</option>{schedule?.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
          <label><select value={tagId} onChange={(event) => setTagId(event.target.value)}><option value="">标签：全部</option>{tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></label>
          <label className="toggle-label"><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} disabled={trashMode} /><i />显示已归档</label>
          <button className={`trash-toggle ${trashMode ? "active" : ""}`} type="button" onClick={() => setTrashMode((value) => !value)}><Trash2 size={15} />{trashMode ? "返回资料库" : "回收站"}</button>
        </div>
        {error ? <div className="inline-error">{error}</div> : null}
        <div className="resource-table-wrap">
          <div className="resource-table-header"><span>资源名称</span><span>类型</span><span>阶段</span><span>来源任务</span><span>标签</span><span>当前版本</span><span>大小</span><span>更新时间</span></div>
          {loading ? <div className="table-loading"><LoaderCircle className="spin" size={20} />正在读取资料版本</div> : visibleResources.length === 0 ? <div className="table-empty"><FilePlus2 size={24} /><strong>{trashMode ? "回收站为空" : "还没有符合条件的资料"}</strong><span>{trashMode ? "删除的资料会保留 30 天。" : "上传文件或新建 Markdown 文档开始沉淀成果。"}</span></div> : visibleResources.map((resource) => {
            const version = resource.currentVersion;
            return <button key={resource.id} className={`resource-table-row ${selectedId === resource.id ? "selected" : ""}`} type="button" onClick={() => setSelectedId(resource.id)}><span className="resource-name"><i className={`resource-icon kind-${resource.kind}`}><ResourceIcon kind={resource.kind} mimeType={version?.mimeType} /></i><span><strong>{resource.title}</strong>{resource.archivedAt ? <small>已归档</small> : null}</span></span><span>{resource.kind === "markdown" ? "Markdown" : "文件"}</span><span>{phaseName(resource.phaseId)}</span><span title={taskName(resource.sourceTaskId)}>{taskName(resource.sourceTaskId)}</span><span className="tag-cell">{resource.tags.slice(0, 2).map((tag) => <i key={tag.id} style={{ color: tag.color, backgroundColor: `${tag.color}12`, borderColor: `${tag.color}35` }}>{tag.name}</i>)}</span><span>v{resource.currentVersionNumber}</span><span>{version ? formatBytes(version.byteSize) : "—"}</span><span>{new Date(resource.updatedAt).toLocaleDateString("zh-CN")}</span></button>;
          })}
        </div>
      </section>
      {detail ? <ResourceDrawer projectId={projectId} detail={detail} schedule={schedule} tags={tags} online={online} trashMode={trashMode} onClose={() => { setSelectedId(undefined); setDetail(undefined); }} onAddVersion={() => setShowVersion(true)} onChanged={refreshSelected} /> : null}
      {showCreate ? <ResourceEditorDialog kind={showCreate} projectId={projectId} schedule={schedule} tags={tags} online={online} onClose={() => setShowCreate(undefined)} onCreated={async (resourceId) => { setShowCreate(undefined); await loadResources(); setSelectedId(resourceId); }} /> : null}
      {showVersion && detail ? <VersionDialog projectId={projectId} detail={detail} online={online} onClose={() => setShowVersion(false)} onCreated={async () => { setShowVersion(false); await refreshSelected(); }} /> : null}
      {showTags ? <TagDialog projectId={projectId} tags={tags} online={online} onClose={() => setShowTags(false)} onChanged={async () => { const result = await api.get<{ tags: TagEntity[] }>(`/api/projects/${projectId}/tags`); setTags(result.tags); }} /> : null}
    </div>
  );
}

function ResourceDrawer({ projectId, detail, schedule, tags, online, trashMode, onClose, onAddVersion, onChanged }: { projectId: string; detail: ResourceDetail; schedule?: Schedule; tags: TagEntity[]; online: boolean; trashMode: boolean; onClose: () => void; onAddVersion: () => void; onChanged: () => Promise<void> }) {
  const resource = detail.resource;
  const current = detail.versions.find((version) => version.versionNumber === resource.currentVersionNumber);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(resource.title);
  const [phaseId, setPhaseId] = useState(resource.phaseId ?? "");
  const [sourceTaskId, setSourceTaskId] = useState(resource.sourceTaskId ?? "");
  const [tagIds, setTagIds] = useState(resource.tags.map((tag) => tag.id));
  const [error, setError] = useState("");
  useEffect(() => { setTitle(resource.title); setPhaseId(resource.phaseId ?? ""); setSourceTaskId(resource.sourceTaskId ?? ""); setTagIds(resource.tags.map((tag) => tag.id)); setEditing(false); }, [resource.id, resource.revision]);
  const act = async (operation: () => Promise<unknown>): Promise<boolean> => { setError(""); try { await operation(); await onChanged(); return true; } catch (caught) { setError(errorMessage(caught)); return false; } };
  const save = () => void act(() => api.patch(`/api/projects/${projectId}/resources/${resource.id}`, { expectedRevision: resource.revision, title, phaseId: phaseId || null, sourceTaskId: sourceTaskId || null, tagIds })).then((succeeded) => { if (succeeded) setEditing(false); });
  const archive = () => void act(() => api.post(`/api/projects/${projectId}/resources/${resource.id}/${resource.archivedAt ? "unarchive" : "archive"}`, { expectedRevision: resource.revision }));
  const trash = () => { if (window.confirm(`将“${resource.title}”移入回收站？`)) void act(() => api.delete(`/api/projects/${projectId}/resources/${resource.id}`, { expectedRevision: resource.revision })); };
  const restore = () => void act(() => api.post(`/api/projects/${projectId}/resources/${resource.id}/restore`, { expectedRevision: resource.revision }));
  const permanent = () => { if (window.confirm("永久删除后无法恢复，是否继续？")) void act(() => api.delete(`/api/projects/${projectId}/resources/${resource.id}/permanent`, { expectedRevision: resource.revision, confirmation: "PERMANENT_DELETE" })).then((succeeded) => { if (succeeded) onClose(); }); };
  const restoreVersion = (version: ResourceVersionEntity) => { if (window.confirm(`将 v${version.versionNumber} 恢复为一个新版本？`)) void act(() => api.post(`/api/projects/${projectId}/resources/${resource.id}/versions/${version.id}/restore`, { expectedRevision: resource.revision, versionNote: `恢复自 v${version.versionNumber}` })); };
  const download = (version: ResourceVersionEntity) => { window.location.assign(`/api/projects/${projectId}/resources/${resource.id}/versions/${version.id}/download`); };
  return <aside className="resource-drawer"><header className="drawer-header"><div className="resource-title"><i className={`resource-icon kind-${resource.kind}`}><ResourceIcon kind={resource.kind} mimeType={current?.mimeType} /></i><div><small>{resource.kind === "markdown" ? "Markdown 文档" : "上传文件"}</small><h2>{resource.title}</h2></div></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭资料详情" title="关闭"><X size={19} /></button></header><div className="resource-meta">{editing ? <div className="drawer-form"><label>名称<input value={title} onChange={(event) => setTitle(event.target.value)} /></label><div className="form-grid two-columns"><label>阶段<select value={phaseId} onChange={(event) => setPhaseId(event.target.value)}><option value="">无</option>{schedule?.phases.map((phase) => <option key={phase.id} value={phase.id}>{phase.name}</option>)}</select></label><label>来源任务<select value={sourceTaskId} onChange={(event) => setSourceTaskId(event.target.value)}><option value="">无</option>{schedule?.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label></div><fieldset className="tag-checks"><legend>标签</legend>{tags.map((tag) => <label key={tag.id}><input type="checkbox" checked={tagIds.includes(tag.id)} onChange={() => setTagIds((currentIds) => currentIds.includes(tag.id) ? currentIds.filter((id) => id !== tag.id) : [...currentIds, tag.id])} /><i style={{ backgroundColor: tag.color }} />{tag.name}</label>)}</fieldset><div className="inline-actions"><button className="secondary-button" type="button" onClick={() => setEditing(false)}>取消</button><button className="primary-button" type="button" onClick={save} disabled={!online}><Check size={15} />保存</button></div></div> : <><dl><div><dt>阶段</dt><dd>{schedule?.phases.find((phase) => phase.id === resource.phaseId)?.name ?? "未归档到阶段"}</dd></div><div><dt>来源任务</dt><dd>{schedule?.tasks.find((task) => task.id === resource.sourceTaskId)?.title ?? "无"}</dd></div><div><dt>标签</dt><dd className="tag-cell">{resource.tags.length ? resource.tags.map((tag) => <i key={tag.id} style={{ color: tag.color, backgroundColor: `${tag.color}12` }}>{tag.name}</i>) : "无"}</dd></div></dl>{!trashMode ? <button className="text-button" type="button" onClick={() => setEditing(true)}><Pencil size={14} />编辑归档信息</button> : null}</>}</div><div className="resource-actions">{trashMode ? <><button className="secondary-button" type="button" onClick={restore} disabled={!online}><ArchiveRestore size={16} />恢复</button><button className="danger-button" type="button" onClick={permanent} disabled={!online}><Trash2 size={16} />永久删除</button></> : <><button className="primary-button" type="button" onClick={() => current && download(current)} disabled={!current}><Download size={16} />下载</button><button className="secondary-button" type="button" onClick={onAddVersion} disabled={!online || Boolean(resource.archivedAt)}><Plus size={16} />添加版本</button><button className="secondary-button" type="button" onClick={archive} disabled={!online}>{resource.archivedAt ? <ArchiveRestore size={16} /> : <Archive size={16} />}{resource.archivedAt ? "取消归档" : "归档"}</button><button className="danger-text-button" type="button" onClick={trash} disabled={!online}><Trash2 size={16} />移至回收站</button></>}</div>{error ? <p className="form-error resource-error">{error}</p> : null}<section className="version-history"><header><h3>版本历史</h3><span>{detail.versions.length} 个版本</span></header>{detail.versions.map((version) => <article key={version.id} className={version.versionNumber === resource.currentVersionNumber ? "current" : ""}><span><strong>v{version.versionNumber}</strong>{version.versionNumber === resource.currentVersionNumber ? <i>当前</i> : null}</span><div><strong>{version.originalFilename}</strong><small>{formatBytes(version.byteSize)} · SHA {version.sha256.slice(0, 7)}</small></div><div><span>{new Date(version.createdAt).toLocaleString("zh-CN")}</span><small>{version.versionNote || "无版本说明"}</small></div><div><button className="icon-button" type="button" title="下载" onClick={() => download(version)}><Download size={15} /></button>{version.versionNumber !== resource.currentVersionNumber ? <button className="icon-button" type="button" title="恢复为新版本" onClick={() => restoreVersion(version)} disabled={!online || Boolean(resource.archivedAt)}><RotateCcw size={15} /></button> : null}</div></article>)}</section>{resource.kind === "markdown" && current?.markdownContent !== null ? <section className="markdown-preview"><header><h3>Markdown 预览</h3><span>v{current?.versionNumber}</span></header><div className="markdown-body"><ReactMarkdown>{current?.markdownContent ?? ""}</ReactMarkdown></div></section> : null}</aside>;
}

function ResourceEditorDialog({ kind, projectId, schedule, tags, online, onClose, onCreated }: { kind: "markdown" | "file"; projectId: string; schedule?: Schedule; tags: TagEntity[]; online: boolean; onClose: () => void; onCreated: (resourceId: string) => Promise<void> }) {
  const [title, setTitle] = useState(""); const [content, setContent] = useState(""); const [file, setFile] = useState<File>(); const [phaseId, setPhaseId] = useState(""); const [taskId, setTaskId] = useState(""); const [tagIds, setTagIds] = useState<string[]>([]); const [note, setNote] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!online) return; setBusy(true); setError(""); try { const result = await api.multipart<{ resource: ResourceEntity }>(`/api/projects/${projectId}/resources`, { kind, title, ...(kind === "markdown" ? { markdownContent: content } : {}), ...(phaseId ? { phaseId } : {}), ...(taskId ? { sourceTaskId: taskId } : {}), tagIds, versionNote: note }, file); await onCreated(result.resource.id); } catch (caught) { setError(errorMessage(caught)); } finally { setBusy(false); } };
  return <Modal title={kind === "markdown" ? "新建 Markdown" : "上传文件"} onClose={onClose} width="large"><form className="modal-body drawer-form resource-editor" onSubmit={submit}><label>资料名称<input value={title} onChange={(event) => setTitle(event.target.value)} required autoFocus /></label>{kind === "markdown" ? <label>Markdown 内容<textarea className="markdown-editor" rows={14} value={content} onChange={(event) => setContent(event.target.value)} required /></label> : <label className="file-drop"><Upload size={24} /><strong>{file?.name ?? "选择要上传的文件"}</strong><span>单文件上限由团队主机配置，默认 200 MB</span><input type="file" onChange={(event) => setFile(event.target.files?.[0])} required /></label>}<div className="form-grid two-columns"><label>阶段<select value={phaseId} onChange={(event) => setPhaseId(event.target.value)}><option value="">无</option>{schedule?.phases.map((phase) => <option key={phase.id} value={phase.id}>{phase.name}</option>)}</select></label><label>来源任务<select value={taskId} onChange={(event) => setTaskId(event.target.value)}><option value="">无</option>{schedule?.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label></div><label>版本说明<input value={note} onChange={(event) => setNote(event.target.value)} placeholder="本版本完成了什么" /></label><fieldset className="tag-checks"><legend>标签</legend>{tags.map((tag) => <label key={tag.id}><input type="checkbox" checked={tagIds.includes(tag.id)} onChange={() => setTagIds((ids) => ids.includes(tag.id) ? ids.filter((id) => id !== tag.id) : [...ids, tag.id])} /><i style={{ backgroundColor: tag.color }} />{tag.name}</label>)}</fieldset>{error ? <p className="form-error">{error}</p> : null}<footer className="modal-actions"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={!online || busy || (kind === "file" && !file)}>{busy ? <LoaderCircle className="spin" size={16} /> : kind === "file" ? <Upload size={16} /> : <FilePlus2 size={16} />}{busy ? "正在保存…" : "创建资料"}</button></footer></form></Modal>;
}

function VersionDialog({ projectId, detail, online, onClose, onCreated }: { projectId: string; detail: ResourceDetail; online: boolean; onClose: () => void; onCreated: () => Promise<void> }) {
  const [content, setContent] = useState(detail.versions.find((version) => version.versionNumber === detail.resource.currentVersionNumber)?.markdownContent ?? ""); const [file, setFile] = useState<File>(); const [note, setNote] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { await api.multipart(`/api/projects/${projectId}/resources/${detail.resource.id}/versions`, { expectedRevision: detail.resource.revision, ...(detail.resource.kind === "markdown" ? { markdownContent: content } : {}), versionNote: note }, file); await onCreated(); } catch (caught) { setError(errorMessage(caught)); } finally { setBusy(false); } };
  return <Modal title={`添加 ${detail.resource.title} 的新版本`} onClose={onClose} width="large"><form className="modal-body drawer-form" onSubmit={submit}>{detail.resource.kind === "markdown" ? <label>Markdown 内容<textarea className="markdown-editor" rows={14} value={content} onChange={(event) => setContent(event.target.value)} required /></label> : <label className="file-drop"><Upload size={24} /><strong>{file?.name ?? "选择新版本文件"}</strong><input type="file" onChange={(event) => setFile(event.target.files?.[0])} required /></label>}<label>版本说明<input value={note} onChange={(event) => setNote(event.target.value)} required placeholder="说明本版本的变化" /></label>{error ? <p className="form-error">{error}</p> : null}<footer className="modal-actions"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={!online || busy || (detail.resource.kind === "file" && !file)}><Plus size={16} />{busy ? "上传中…" : "添加版本"}</button></footer></form></Modal>;
}

function TagDialog({ projectId, tags, online, onClose, onChanged }: { projectId: string; tags: TagEntity[]; online: boolean; onClose: () => void; onChanged: () => Promise<void> }) {
  const [name, setName] = useState(""); const [color, setColor] = useState("#2563eb"); const [error, setError] = useState("");
  const add = async () => { try { await api.post(`/api/projects/${projectId}/tags`, { name, color }); setName(""); await onChanged(); } catch (caught) { setError(errorMessage(caught)); } };
  const remove = async (tag: TagEntity) => { try { await api.delete(`/api/projects/${projectId}/tags/${tag.id}`, { expectedRevision: tag.revision }); await onChanged(); } catch (caught) { setError(errorMessage(caught)); } };
  return <Modal title="项目标签" onClose={onClose} width="small"><div className="modal-body"><div className="tag-manager">{tags.map((tag) => <div key={tag.id}><i style={{ backgroundColor: tag.color }} /><span>{tag.name}</span><button className="icon-button" type="button" title="删除标签" aria-label={`删除标签 ${tag.name}`} onClick={() => void remove(tag)} disabled={!online}><Trash2 size={14} /></button></div>)}</div><div className="inline-add tag-add"><input type="color" value={color} onChange={(event) => setColor(event.target.value)} aria-label="标签颜色" /><input value={name} onChange={(event) => setName(event.target.value)} placeholder="标签名称" /><button className="primary-button" type="button" onClick={() => void add()} disabled={!online || !name}><Plus size={15} />添加</button></div>{error ? <p className="form-error">{error}</p> : null}</div></Modal>;
}
