import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowDown, ArrowDownToLine, ArrowUp, Check, ChevronDown, ChevronRight, CircleAlert,
  Clock3, Database, File, FileCode2, FileImage, FileSpreadsheet, FileText, FolderOpen, HardDrive,
  LoaderCircle, Menu, MessageSquare, PanelRightClose, PanelRightOpen, Paperclip,
  Plus, RefreshCw, Search, Sparkles, Square, Terminal, UploadCloud, X,
} from 'lucide-react';
import type { AppError, Attachment, Chat, ChatSummary, Health, Message, Run, RunEvent, RunStatus, ToolActivity, WorkspaceFile } from '../shared/types';
import { api, errorInfo, post } from './api';
import WorkflowApp, { WorkflowNavigation, type AppPage, type WorkflowComposerState } from './WorkflowApp';

interface Draft { text: string; attachments: Attachment[]; uploads: number }
interface LiveRun { run: Run; text: string; connected: boolean; progress?: string }
type TextPreview = { kind: 'text'; text: string; truncated: boolean; mime: string };
const EMPTY_DRAFT: Draft = { text: '', attachments: [], uploads: 0 };
const OfficePreview = lazy(() => import('./OfficePreview'));
const PdfPreview = lazy(() => import('./PdfPreview'));
const FINAL_STATUSES: RunStatus[] = ['completed', 'failed', 'stopped', 'interrupted'];
const isActive = (run?: Run | null) => !!run && !FINAL_STATUSES.includes(run.status);
const fileURL = (action: 'content' | 'download', path: string) => `/api/files/${action}?path=${encodeURIComponent(path)}`;

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function elapsed(start: string, finish?: string, now = Date.now()): string {
  return duration((finish ? Date.parse(finish) : now) - Date.parse(start));
}

function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (!Number.isFinite(seconds)) return '0s';
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function workspacePath(value: string): string | null {
  let path = value;
  try { path = decodeURIComponent(path); } catch { /* Preserve malformed text as a non-link. */ }
  path = path.replace(/^(?:sandbox:|file:\/\/)/, '');
  return path.startsWith('/workspace/') ? path.slice('/workspace/'.length) : null;
}

const relativePath = (path: string) => path.replace(/^\/workspace\//, '');
const isOutput = (file: Attachment) => relativePath(file.path).startsWith('outputs/');
const isUpload = (file: Attachment) => relativePath(file.path).startsWith('uploads/');

function FileGlyph({ file, size = 18 }: { file: Attachment; size?: number }) {
  if (file.mime.startsWith('image/')) return <FileImage size={size} />;
  if (/\.(xlsx?|csv|tsv)$/i.test(file.name)) return <FileSpreadsheet size={size} />;
  if (/\.(json|py|js|ts|html|css|sh|sql)$/i.test(file.name)) return <FileCode2 size={size} />;
  if (file.mime.startsWith('text/') || /\.(pdf|docx?|md|txt)$/i.test(file.name)) return <FileText size={size} />;
  return <File size={size} />;
}

function ErrorNotice({ error, onDismiss }: { error: AppError; onDismiss?: () => void }) {
  return <div className="error-notice" role="alert">
    <CircleAlert size={17} className="error-icon" />
    <div><p>{error.message}</p>{error.details && <details><summary>Details</summary><pre>{error.details}</pre></details>}</div>
    {onDismiss && <button type="button" className="icon-button" aria-label="Dismiss error" onClick={onDismiss}><X size={16} /></button>}
  </div>;
}

function ToolList({ tools, running }: { tools: ToolActivity[]; running: boolean }) {
  if (!tools.length) return null;
  const finished = tools.filter(tool => tool.status === 'completed').length;
  const current = [...tools].reverse().find(tool => ['pending', 'running'].includes(tool.status));
  const label = current ? (current.name === 'bash' ? 'Running a command' : `${current.name === 'read' ? 'Reading' : current.name === 'write' ? 'Writing' : 'Editing'} a file`) : `${finished} ${finished === 1 ? 'step' : 'steps'} completed`;
  return <details className="tool-group">
    <summary><span className={running && current ? 'status-dot working' : 'status-dot'} />{label}<ChevronDown size={14} /><span className="tool-count">{tools.length}</span></summary>
    <div className="tool-list">{tools.map(tool => <details className={`tool-item tool-${tool.status}`} key={tool.id}>
      <summary>
        {tool.status === 'running' || tool.status === 'pending' ? <LoaderCircle size={15} className="spin" /> : tool.status === 'completed' ? <Check size={15} /> : <CircleAlert size={15} />}
        <span className="tool-name">{tool.name === 'bash' ? <Terminal size={14} /> : <FileCode2 size={14} />}{tool.name}</span>
        <span className="tool-state">{tool.status}</span><ChevronDown size={13} />
      </summary>
      <div className="tool-details"><div className="detail-label">Arguments</div><pre>{formatArguments(tool.arguments)}</pre>{tool.output && <><div className="detail-label">Output</div><pre>{tool.output}</pre></>}{tool.error && <ErrorNotice error={tool.error} />}</div>
    </details>)}</div>
  </details>;
}

function formatArguments(args: string): string {
  try { return JSON.stringify(JSON.parse(args), null, 2); } catch { return args; }
}

function ArtifactCard({ file, onPreview }: { file: WorkspaceFile; onPreview: (file: WorkspaceFile) => void }) {
  return <div className="artifact-card">
    <button className="artifact-open" onClick={() => onPreview(file)} type="button"><span className="artifact-icon"><FileGlyph file={file} size={23} /></span><span><strong>{file.name}</strong><small>{bytes(file.size)} · Ready to download</small></span></button>
    <a className="icon-button" href={fileURL('download', file.path)} download={file.name} aria-label={`Download ${file.name}`}><ArrowDownToLine size={17} /></a>
  </div>;
}

function MessageView({ message, files, live, onPreview, now }: { message: Message; files: WorkspaceFile[]; live: LiveRun | null; onPreview: (file: WorkspaceFile) => void; now: number }) {
  const current = live?.run.id === message.runId ? live : null;
  const text = current ? current.text : message.text;
  const tools = current ? current.run.tools : message.tools;
  const status = current ? current.run.status : message.status;
  const running = !!status && !FINAL_STATUSES.includes(status);
  const error = current?.run.error ?? message.error;
  const usage = current?.run.usage ?? message.usage;
  const durationText = current ? elapsed(current.run.startedAt, current.run.finishedAt, now) : message.elapsedMs !== undefined ? duration(message.elapsedMs) : null;
  const artifactPaths = new Set((message.artifacts ?? []).map(file => relativePath(file.path)));
  for (const match of text.matchAll(/(?:sandbox:|file:\/\/)?\/workspace\/outputs\/[^\s\)\]<>"'`]+/g)) {
    const path = workspacePath(match[0].replace(/[.,;:]+$/, ''));
    if (path) artifactPaths.add(path);
  }
  const artifacts = files.filter(file => artifactPaths.has(relativePath(file.path)));
  if (message.role === 'user') return <article className="message user-message">
    <div className="message-label">You</div><div className="user-message-body">{text && <p>{text}</p>}{message.attachments.length > 0 && <div className="sent-attachments">{message.attachments.map(file => <a key={file.path} href={fileURL('download', file.path)} download={file.name}><FileGlyph file={file} size={15} /><span>{file.name}</span></a>)}</div>}</div>
  </article>;
  return <article className="message assistant-message" aria-busy={running}>
    <div className="assistant-heading"><span className="assistant-avatar"><Sparkles size={15} /></span><span>T-force</span>{running && <span className="responding-label">{current?.connected === false ? 'Reconnecting…' : 'Working'}</span>}</div>
    {running && current?.progress && <p className="run-progress"><LoaderCircle size={12} className="spin" />{current.progress}</p>}
    <ToolList tools={tools} running={running} />
    {text ? <div className={`markdown ${running ? 'streaming' : ''}`}><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={url => url} components={{
      a: ({ href, children }) => {
        const path = href ? workspacePath(href) : null;
        if (path) {
          const file = files.find(file => relativePath(file.path) === path);
          return file ? <button type="button" className="file-inline-link" onClick={() => onPreview(file)}><FileGlyph file={file} size={14} />{children}</button> : <span className="unverified-file" title="This file is not available in the workspace">{children}</span>;
        }
        if (!href || !/^(https?:|mailto:)/i.test(href)) return <span>{children}</span>;
        return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
      },
      img: ({ src, alt }) => {
        const path = src ? workspacePath(src) : null;
        const file = path ? files.find(file => relativePath(file.path) === path && /^(image\/)(png|jpeg|gif|webp|bmp)$/.test(file.mime)) : null;
        return file ? <button className="markdown-image" type="button" onClick={() => onPreview(file)}><img src={fileURL('content', file.path)} alt={alt ?? file.name} /></button> : <span className="unverified-file">{alt || 'Image reference'}</span>;
      },
    }}>{text}</ReactMarkdown></div> : running ? <div className="thinking-indicator" aria-label="Agent is working"><i /><i /><i /></div> : null}
    {artifacts.length > 0 && <div className="artifact-list">{artifacts.map(file => <ArtifactCard file={file} key={file.path} onPreview={onPreview} />)}</div>}
    {error && <ErrorNotice error={error} />}
    {status === 'stopped' && <p className="message-outcome"><Square size={12} />Stopped. Files already written remain in the workspace.</p>}
    {status === 'interrupted' && <p className="message-outcome"><CircleAlert size={13} />Interrupted by a server restart. Actions were not repeated.</p>}
    {(!running && (usage?.totalTokens || durationText)) ? <div className="message-meta">{durationText && <span><Clock3 size={12} />{durationText}</span>}{usage && usage.totalTokens > 0 && <span title={`${usage.inputTokens.toLocaleString()} input · ${usage.outputTokens.toLocaleString()} output`}>{usage.totalTokens.toLocaleString()} tokens</span>}</div> : null}
  </article>;
}

function PreviewDialog({ file, onClose }: { file: WorkspaceFile; onClose: () => void }) {
  const [preview, setPreview] = useState<TextPreview | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(true);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const imageFile = /^(image\/)(png|jpeg|gif|webp|bmp)$/.test(file.mime);
  const pdfFile = file.mime === 'application/pdf' || /\.pdf$/i.test(file.name);
  const officeFile = /\.(docx|xlsx)$/i.test(file.name);
  const unsupportedFile = /\.(zip|sqlite|db|pptx|doc|xls|exe|bin)$/i.test(file.name);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], iframe, input, textarea, [tabindex="0"]') ?? []);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        // Keyboard events inside the Word preview frame do not bubble to the parent.
        if ((event.target as Node | null)?.ownerDocument && (event.target as Node).ownerDocument !== document) {
          const index = focusable.indexOf(document.activeElement as HTMLElement);
          event.preventDefault();
          focusable[(index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus();
        } else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    const frames = new Map<HTMLIFrameElement, () => void>();
    const frameDocuments = new Set<Document>();
    const attachFrames = () => {
      for (const frame of dialogRef.current?.querySelectorAll<HTMLIFrameElement>('iframe') ?? []) {
        if (frames.has(frame)) continue;
        const attach = () => {
          try { const child = frame.contentDocument; if (child && !frameDocuments.has(child)) { child.addEventListener('keydown',listener);frameDocuments.add(child); } } catch { /* External frames cannot receive parent listeners. */ }
        };
        frames.set(frame,attach);frame.addEventListener('load',attach);attach();
      }
    };
    const observer = new MutationObserver(attachFrames);
    if (dialogRef.current) observer.observe(dialogRef.current,{childList:true,subtree:true});
    attachFrames();document.addEventListener('keydown', listener);
    return () => { observer.disconnect();for(const [frame,attach] of frames)frame.removeEventListener('load',attach);for(const child of frameDocuments)child.removeEventListener('keydown',listener);document.removeEventListener('keydown', listener); previousFocus?.focus(); };
  }, [onClose]);
  useEffect(() => {
    let cancelled = false;
    setPreview(null); setError(null); setLoading(true);
    if (imageFile) return;
    if (pdfFile || officeFile || unsupportedFile) {setLoading(false);return;}
    api<TextPreview>(`/files/preview?path=${encodeURIComponent(file.path)}`).then(result => { if (!cancelled) { setPreview(result); setLoading(false); } }).catch(error => { if (!cancelled) { setError(errorInfo(error)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [file.path, file.modifiedAt, imageFile, pdfFile, officeFile, unsupportedFile]);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="preview-dialog" role="dialog" aria-modal="true" aria-labelledby="preview-title">
      <header><span className="preview-file-icon"><FileGlyph file={file} size={20} /></span><div><h2 id="preview-title">{file.name}</h2><p>{bytes(file.size)} <span>·</span> {file.path}</p></div><a href={fileURL('download', file.path)} download={file.name} className="button secondary"><ArrowDownToLine size={15} />Download</a><button ref={closeRef} className="icon-button" type="button" onClick={onClose} aria-label="Close preview"><X size={20} /></button></header>
      <div className={`preview-body ${imageFile ? 'image-preview' : ''}`}>
        {loading && !pdfFile && <div className="preview-loading"><LoaderCircle className="spin" size={23} /><span>Loading preview</span></div>}
        {imageFile && <img src={fileURL('content', file.path)} alt={file.name} onLoad={() => setLoading(false)} onError={() => { setLoading(false); setError({ code: 'preview_error', message: 'This image could not be previewed. You can still download the file.' }); }} />}
        {pdfFile && <Suspense fallback={<div className="preview-loading"><LoaderCircle size={23} className="spin" /><span>Loading PDF viewer</span></div>}><PdfPreview file={file} /></Suspense>}
        {officeFile && <Suspense fallback={<div className="preview-loading"><LoaderCircle size={23} className="spin" /><span>Loading document preview</span></div>}><OfficePreview file={file} /></Suspense>}
        {unsupportedFile && <div className="preview-error"><File size={30} /><p>Preview is not available for this file format.</p><a className="button secondary" href={fileURL('download',file.path)} download={file.name}>Download file</a></div>}
        {preview && <><pre className="text-preview">{preview.text}</pre>{preview.truncated && <div className="preview-truncated">Preview is truncated. Download the file to see its full contents.</div>}</>}
        {error && <div className="preview-error"><ErrorNotice error={error} /><a className="button secondary" href={fileURL('download', file.path)} download={file.name}>Download file</a></div>}
      </div>
    </section>
  </div>;
}

export default function App() {
  const [page, setPage] = useState<AppPage>(() => {
    const saved = localStorage.getItem('office.page');
    return saved === 'workflows' || saved === 'create' || saved === 'cases' ? saved : 'chat';
  });
  useEffect(() => { localStorage.setItem('office.page', page); }, [page]);
  const [health, setHealth] = useState<Health | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [chatCache, setChatCache] = useState<Record<string, Chat>>({});
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [live, setLive] = useState<LiveRun | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  // Keep workflow drafts with the app so uploads can finish in their original
  // composer while the user visits Chat. No document content is persisted here.
  const [workflowComposers, setWorkflowComposers] = useState<WorkflowComposerState>({ author: {}, correction: {} });
  const [initializing, setInitializing] = useState(true);
  const [chatLoading, setChatLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [workspaceError, setWorkspaceError] = useState<AppError | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(() => {
    const saved = localStorage.getItem('office.workspace-open');
    return saved === null ? window.matchMedia('(min-width: 960px)').matches : saved !== 'false';
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<WorkspaceFile | null>(null);
  const [fileFilter, setFileFilter] = useState('');
  const [refreshingFiles, setRefreshingFiles] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [scrolledAway, setScrolledAway] = useState(false);
  const sendingRef = useRef(false);
  const creatingRef = useRef(false);
  const selectedRef = useRef(selectedId);
  const liveRef = useRef(live);
  const healthRef = useRef(health);
  const healthRequest = useRef(0);
  const lastEvents = useRef<Record<string, number>>({});
  const chatRequest = useRef(0);
  const chatVersions = useRef<Record<string, number>>({});
  const fileRequest = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  selectedRef.current = selectedId;
  liveRef.current = live;
  healthRef.current = health;

  const updateLive = useCallback((update: (current: LiveRun | null) => LiveRun | null) => {
    setLive(current => { const next = update(current); liveRef.current = next; return next; });
  }, []);
  const refreshHealth = useCallback(async () => {
    const request = ++healthRequest.current;
    const result = await api<Health>('/health');
    if (request !== healthRequest.current) return result;
    healthRef.current = result; setHealth(result);
    if (result.activeRun && isActive(result.activeRun) && (!result.activeExecution || result.activeExecution.kind === 'chat')) {
      // Concurrent health replies must preserve the same run's replayed text and cursor.
      updateLive(current => current?.run.id === result.activeRun!.id ? current : { run: result.activeRun!, text: '', connected: false });
    }
    return result;
  }, [updateLive]);
  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      try { await refreshHealth(); } catch { /* Existing errors stay visible; polling never resubmits work. */ }
      if (!disposed) timer = window.setTimeout(poll, healthRef.current?.activeExecution ? 1000 : 5000);
    };
    void poll();
    const focus = () => { void refreshHealth().catch(() => {}); };
    window.addEventListener('focus', focus);
    return () => { disposed = true; if (timer !== undefined) clearTimeout(timer); window.removeEventListener('focus', focus); };
  }, [refreshHealth]);
  useEffect(() => { void refreshHealth().catch(() => {}); }, [page, refreshHealth]);
  const refreshChats = useCallback(async () => { const result = await api<ChatSummary[]>('/chats'); setChats(result); return result; }, []);
  const refreshFiles = useCallback(async () => {
    const request = ++fileRequest.current;
    setRefreshingFiles(true);
    try { const result = await api<WorkspaceFile[]>('/files'); if (request === fileRequest.current) { setFiles(result); setWorkspaceError(null); } return result; }
    catch (error) { if (request === fileRequest.current) setWorkspaceError(errorInfo(error)); return []; }
    finally { if (request === fileRequest.current) setRefreshingFiles(false); }
  }, []);
  const loadChat = useCallback(async (id: string, showLoading = true) => {
    const request = ++chatRequest.current;
    const version = (chatVersions.current[id] ?? 0) + 1;
    chatVersions.current[id] = version;
    if (showLoading) setChatLoading(true);
    try {
      const chat = await api<Chat>(`/chats/${encodeURIComponent(id)}`);
      if (chatVersions.current[id] === version) setChatCache(cache => ({ ...cache, [id]: chat }));
      return chat;
    } catch (error) { if (selectedRef.current === id && chatVersions.current[id] === version) setError(errorInfo(error)); return null; }
    finally { if (request === chatRequest.current) setChatLoading(false); }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const initialFilesRequest = ++fileRequest.current;
    void refreshHealth().then(result => {
      if (cancelled) return;
      if (result.activeRun && (!result.activeExecution || result.activeExecution.kind === 'chat')) {
        if (!selectedRef.current) { selectedRef.current = result.activeRun.chatId; setSelectedId(result.activeRun.chatId); }
      }
    }).catch(error => { if (!cancelled) setError(errorInfo(error)); });
    Promise.allSettled([api<ChatSummary[]>('/chats'), api<WorkspaceFile[]>('/files')]).then(results => {
      if (cancelled) return;
      const [chatsResult, filesResult] = results;
      if (initialFilesRequest === fileRequest.current) {
        if (filesResult.status === 'fulfilled') setFiles(filesResult.value); else setWorkspaceError(errorInfo(filesResult.reason));
      }
      if (chatsResult.status === 'fulfilled') {
        setChats(chatsResult.value);
        const remembered = localStorage.getItem('office.selected-chat');
        const id = chatsResult.value.find(chat => chat.id === remembered)?.id
          ?? selectedRef.current
          ?? chatsResult.value[0]?.id
          ?? null;
        if (id) { selectedRef.current = id; setSelectedId(id); }
      } else setError(errorInfo(chatsResult.reason));
      setInitializing(false);
    });
    return () => { cancelled = true; };
  }, [updateLive, refreshHealth]);

  useEffect(() => {
    // Initial history lookup must read the remembered chat before a null selection can clear it.
    if (initializing) return;
    if (selectedId) { localStorage.setItem('office.selected-chat', selectedId); void loadChat(selectedId); }
    else { localStorage.removeItem('office.selected-chat'); setChatLoading(false); }
    setScrolledAway(false);
  }, [selectedId, loadChat, initializing]);

  useEffect(() => { localStorage.setItem('office.workspace-open', String(workspaceOpen)); }, [workspaceOpen]);
  useEffect(() => {
    if (!isActive(live?.run)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live?.run.id, live?.run.status]);

  useEffect(() => {
    const runId = live?.run.id;
    if (!runId || !isActive(liveRef.current?.run)) return;
    let source: EventSource | null = null;
    let timer: number | undefined;
    let disposed = false;
    let retries = 0;
    const finish = async () => {
      source?.close();
      const current = liveRef.current;
      if (!current || current.run.id !== runId) return;
      await Promise.allSettled([refreshChats(), refreshFiles(), loadChat(current.run.chatId, false).then(chat => { const message = chat?.messages.find(item => item.runId === runId && item.role === 'assistant'); if (message) updateLive(live => live?.run.id === runId ? { ...live, text: message.text } : live); }), api<Run>(`/runs/${encodeURIComponent(runId)}`).then(run => updateLive(live => live?.run.id === runId ? { ...live, run } : live)), api<Health>('/health').then(setHealth)]);
      setStopping(false);
    };
    const connect = () => {
      if (disposed || !isActive(liveRef.current?.run)) return;
      source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events?after=${lastEvents.current[runId] ?? 0}`);
      source.onopen = () => { retries = 0; updateLive(current => current?.run.id === runId ? { ...current, connected: true } : current); };
      source.addEventListener('run', (raw: Event) => {
        let event: RunEvent;
        try { event = JSON.parse((raw as MessageEvent).data) as RunEvent; } catch { return; }
        if (event.runId !== runId || event.id <= (lastEvents.current[runId] ?? 0)) return;
        lastEvents.current[runId] = event.id;
        const data = event.data;
        updateLive(current => {
          if (!current || current.run.id !== runId) return current;
          if (event.type === 'text' && typeof data.delta === 'string') return { ...current, text: current.text + data.delta, progress: undefined };
          if (event.type === 'tool' && data.tool) {
            const tool = data.tool as unknown as ToolActivity;
            const tools = [...current.run.tools];
            const index = tools.findIndex(item => item.id === tool.id);
            if (index === -1) tools.push(tool); else tools[index] = { ...tools[index], ...tool };
            return { ...current, progress: undefined, run: { ...current.run, tools } };
          }
          if (event.type === 'tool_output' && typeof data.delta === 'string') return { ...current, progress: undefined, run: { ...current.run, tools: current.run.tools.map(tool => tool.id === data.callId ? { ...tool, output: (tool.output ?? '') + data.delta } : tool) } };
          if (event.type === 'status' && typeof data.status === 'string') return { ...current, progress: typeof data.detail === 'string' && !FINAL_STATUSES.includes(data.status as RunStatus) ? data.detail : undefined, run: { ...current.run, status: data.status as RunStatus, ...(FINAL_STATUSES.includes(data.status as RunStatus) ? { finishedAt: event.createdAt } : {}) } };
          if (event.type === 'usage' && data.usage) return { ...current, run: { ...current.run, usage: data.usage as unknown as Run['usage'] } };
          if (event.type === 'error' && data.error) return { ...current, run: { ...current.run, error: data.error as unknown as AppError } };
          return current;
        });
        if (event.type === 'files' && Array.isArray(data.files)) { fileRequest.current += 1; setRefreshingFiles(false); setFiles(data.files as unknown as WorkspaceFile[]); }
        if (event.type === 'tool' && data.tool && ['completed', 'failed'].includes((data.tool as unknown as ToolActivity).status)) void refreshFiles();
        if (event.type === 'reset') {
          void api<Run>(`/runs/${encodeURIComponent(runId)}`).then(async run => {
            const chat = await api<Chat>(`/chats/${encodeURIComponent(run.chatId)}`);
            const message = chat.messages.find(message => message.runId === runId && message.role === 'assistant');
            setChatCache(cache => ({ ...cache, [chat.id]: chat }));
            updateLive(current => current?.run.id === runId ? { ...current, run, text: message?.text ?? current.text } : current);
            if (!isActive(run)) await finish();
          }).catch(error => setError(errorInfo(error)));
        }
        if (event.type === 'status' && FINAL_STATUSES.includes(data.status as RunStatus)) void finish();
      });
      source.onerror = () => {
        source?.close();
        if (disposed || !isActive(liveRef.current?.run)) return;
        updateLive(current => current?.run.id === runId ? { ...current, connected: false } : current);
        timer = window.setTimeout(connect, Math.min(1000 * 2 ** retries++, 10000));
      };
    };
    connect();
    return () => { disposed = true; source?.close(); if (timer !== undefined) clearTimeout(timer); };
  }, [live?.run.id, refreshChats, refreshFiles, loadChat, updateLive]);

  const draftKey = selectedId ?? 'new';
  const draft = drafts[draftKey] ?? EMPTY_DRAFT;
  const currentChat = selectedId ? chatCache[selectedId] : null;
  const chatBusy = isActive(live?.run);
  const sharedExecution = health?.activeExecution;
  const busy = chatBusy || !!sharedExecution;
  const workflowExecution = sharedExecution && !['chat', 'authoring'].includes(sharedExecution.kind) ? sharedExecution : null;
  const activeHere = chatBusy && live?.run.chatId === selectedId;
  const ready = !!health?.docker.ready && !!health?.azure.configured;
  const filteredFiles = useMemo(() => files.filter(file => `${file.name} ${file.path}`.toLowerCase().includes(fileFilter.toLowerCase())).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)), [files, fileFilter]);
  const messages = [...(currentChat?.messages ?? [])];
  if (live?.run.chatId === selectedId && !messages.some(message => message.runId === live.run.id && message.role === 'assistant')) messages.push({ id: live.run.messageId, role: 'assistant', text: '', createdAt: live.run.startedAt, attachments: [], tools: [], runId: live.run.id, status: live.run.status });
  const lastText = live?.run.chatId === selectedId ? live.text : '';
  useEffect(() => {
    if (!scrolledAway) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'instant' });
  }, [lastText, messages.length, live?.run.tools.length, scrolledAway, selectedId]);
  useEffect(() => {
    if (textRef.current) { textRef.current.style.height = 'auto'; textRef.current.style.height = `${Math.min(textRef.current.scrollHeight, 180)}px`; }
  }, [draft.text]);

  const changeDraft = (key: string, update: (draft: Draft) => Draft) => setDrafts(current => ({ ...current, [key]: update(current[key] ?? EMPTY_DRAFT) }));
  const chooseChat = (id: string) => { selectedRef.current = id; setSelectedId(id); setSidebarOpen(false); setError(null); };
  const newChat = async () => {
    if (creatingRef.current || creating || initializing) return;
    creatingRef.current = true;
    setCreating(true); setError(null);
    try {
      const chat = await post<Chat>('/chats');
      setChatCache(cache => ({ ...cache, [chat.id]: chat }));
      setChats(chats => [chat, ...chats]);
      chooseChat(chat.id);
      requestAnimationFrame(() => textRef.current?.focus());
    } catch (error) { setError(errorInfo(error)); }
    finally { creatingRef.current = false; setCreating(false); }
  };
  const upload = async (incoming: FileList | globalThis.File[]) => {
    const uploadFiles = Array.from(incoming);
    if (!uploadFiles.length) return;
    const fileLimit = health?.limits.fileBytes ?? 25 * 1024 * 1024;
    const uploadLimit = health?.limits.uploadBytes ?? 100 * 1024 * 1024;
    if (uploadFiles.some(file => file.size > fileLimit)) { setError({ code: 'file_too_large', message: `Each file must be ${bytes(fileLimit)} or smaller.` }); return; }
    if (uploadFiles.reduce((sum, file) => sum + file.size, 0) > uploadLimit) { setError({ code: 'upload_too_large', message: `An upload must be ${bytes(uploadLimit)} or smaller in total.` }); return; }
    const key = draftKey;
    changeDraft(key, draft => ({ ...draft, uploads: draft.uploads + 1 }));
    setError(null);
    const form = new FormData();
    for (const file of uploadFiles) form.append('files', file, file.name);
    try {
      const result = await api<{ files: Attachment[] }>('/files/upload', { method: 'POST', body: form });
      changeDraft(key, draft => ({ ...draft, attachments: [...draft.attachments, ...result.files] }));
      await refreshFiles();
    } catch (error) { setError(errorInfo(error)); }
    finally { changeDraft(key, draft => ({ ...draft, uploads: Math.max(0, draft.uploads - 1) })); }
  };
  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (sendingRef.current || sending || busy || isActive(liveRef.current?.run) || draft.uploads || !ready || (!draft.text.trim() && !draft.attachments.length)) return;
    sendingRef.current = true;
    const key = draftKey;
    const submission = { text: draft.text.trim(), attachments: draft.attachments };
    setSending(true); setError(null);
    try {
      let id = selectedId;
      if (!id) {
        const chat = await post<Chat>('/chats');
        id = chat.id;
        setChats(chats => [chat, ...chats]); setChatCache(cache => ({ ...cache, [chat.id]: chat }));
        selectedRef.current = id; setSelectedId(id);
      }
      const { runId } = await post<{ runId: string }>(`/chats/${encodeURIComponent(id)}/messages`, submission);
      changeDraft(key, () => EMPTY_DRAFT);
      const version = (chatVersions.current[id] ?? 0) + 1;
      chatVersions.current[id] = version;
      const [run, chat] = await Promise.all([api<Run>(`/runs/${encodeURIComponent(runId)}`), api<Chat>(`/chats/${encodeURIComponent(id)}`)]);
      if (chatVersions.current[id] === version) setChatCache(cache => ({ ...cache, [id!]: chat }));
      const assistant = chat.messages.find(message => message.runId === run.id && message.role === 'assistant');
      // Replay starts at zero, so streamed text is rebuilt from the event log.
      updateLive(current => current?.run.id === run.id
        ? isActive(run) ? current : { ...current, run, text: assistant?.text ?? current.text }
        : { run, text: isActive(run) ? '' : assistant?.text ?? '', connected: false });
      setScrolledAway(false);
      void refreshChats().catch(error => setError(errorInfo(error)));
      if (!isActive(run)) void refreshFiles();
    } catch (error) {
      setError(errorInfo(error));
      // A failed response never causes an automatic message resubmission.
      void refreshHealth().then(result => { if (result.activeRun && (!result.activeExecution || result.activeExecution.kind === 'chat')) updateLive(current => current?.run.id === result.activeRun!.id ? current : { run: result.activeRun!, text: '', connected: false }); }).catch(() => {});
    } finally { sendingRef.current = false; setSending(false); textRef.current?.focus(); }
  };
  const stop = async () => {
    if (!live || !busy || stopping) return;
    setStopping(true);
    try { await post(`/runs/${encodeURIComponent(live.run.id)}/abort`); }
    catch (error) { setError(errorInfo(error)); setStopping(false); }
  };
  const onDragEnter = (event: DragEvent) => { if (!event.dataTransfer.types.includes('Files')) return; event.preventDefault(); dragDepth.current += 1; setDragging(true); };
  const onDragLeave = (event: DragEvent) => { event.preventDefault(); dragDepth.current -= 1; if (dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } };
  const onDrop = (event: DragEvent) => { event.preventDefault(); dragDepth.current = 0; setDragging(false); void upload(event.dataTransfer.files); };
  const closePreview = useCallback(() => setPreviewFile(null), []);

  if (page !== 'chat') return <WorkflowApp page={page} onNavigate={setPage} health={health} onExecutionChange={refreshHealth} composers={workflowComposers} onComposersChange={setWorkflowComposers} />;

  return <div className={`app-shell ${workspaceOpen ? 'workspace-visible' : ''}`}>
    {sidebarOpen && <button className="sidebar-backdrop" aria-label="Close conversation sidebar" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? 'sidebar-mobile-open' : ''}`}>
      <a className="brand" href="/" onClick={event => event.preventDefault()}><span className="brand-mark"><Sparkles size={21} /></span><span>T-force<span className="brand-caption">Your local workspace</span></span></a>
      <WorkflowNavigation page={page} onNavigate={setPage} />
      <button type="button" className="new-chat-button" onClick={() => void newChat()} disabled={creating || initializing}><Plus size={18} /><span>New conversation</span>{creating && <LoaderCircle size={15} className="spin" />}</button>
      <div className="sidebar-section-label">Conversations <span>{chats.length}</span></div>
      <nav className="chat-list" aria-label="Conversations">{chats.map(chat => <button type="button" key={chat.id} className={`chat-item ${selectedId === chat.id ? 'selected' : ''}`} onClick={() => chooseChat(chat.id)}><MessageSquare size={16} /><span>{chat.title || 'New conversation'}</span>{chatBusy && live?.run.chatId === chat.id && <span className="status-dot working" />}</button>)}{!chats.length && !initializing && <p className="no-chats">Your conversations will appear here.</p>}{initializing && <div className="sidebar-loading"><LoaderCircle size={17} className="spin" />Loading conversations</div>}</nav>
      <div className="sidebar-footer"><div className="local-badge"><HardDrive size={16} /><div><strong>Local files and execution</strong><span>AI uses your Azure deployment</span></div></div><div className="connection-line"><span className={`status-dot ${health?.docker.ready && health?.azure.configured ? 'online' : 'offline'}`} /><span>{!health ? 'Connecting to server' : !health.docker.ready ? 'Docker unavailable' : !health.azure.configured ? 'Azure setup needed' : 'Ready to work'}</span></div>{health?.database && <div className="database-line" title={health.database.error ?? health.database.path}><Database size={13} /><span>{health.database.exists ? `Shared DB · ${health.database.path.split('/').at(-1)}` : 'Shared DB unavailable'}</span></div>}</div>
    </aside>

    <main className="main-panel" onDragEnter={onDragEnter} onDragLeave={onDragLeave} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={onDrop}>
      <header className="chat-header"><button className="icon-button mobile-menu" aria-label="Open conversations" onClick={() => setSidebarOpen(true)}><Menu size={19} /></button><div className="chat-heading"><h1>{currentChat?.title ?? (selectedId && chatLoading ? 'Loading conversation…' : 'New conversation')}</h1><span><span className="tiny-status-dot" />{health?.model ?? 'Local office agent'}</span></div><button type="button" className={`workspace-toggle ${workspaceOpen ? 'active' : ''}`} onClick={() => setWorkspaceOpen(open => !open)} aria-label={workspaceOpen ? 'Hide workspace' : 'Show workspace'} aria-expanded={workspaceOpen}>{workspaceOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}<span>Workspace</span>{files.length > 0 && <small>{files.length}</small>}</button></header>
      {health && !ready && <div className="setup-banner"><CircleAlert size={16} /><span>{!health.docker.ready ? health.docker.error ?? 'Start Docker and build the sandbox image to run the agent.' : 'Configure the Azure endpoint, key, and GPT-6 Luna deployment to start working.'}</span><button type="button" className="icon-button" aria-label="Check connection again" onClick={() => { void api<Health>('/health').then(setHealth).catch(error => setError(errorInfo(error))); }}><RefreshCw size={15} /></button></div>}
      <div className="conversation-scroll" ref={scrollRef} onScroll={event => { const node = event.currentTarget; setScrolledAway(node.scrollHeight - node.scrollTop - node.clientHeight > 120); }}>
        <div className="conversation-content">
          {chatLoading && !currentChat ? <div className="chat-loading"><LoaderCircle size={24} className="spin" /><span>Loading conversation</span></div> : messages.length === 0 ? <section className="welcome"><div className="welcome-icon"><Sparkles size={31} strokeWidth={1.6} /></div><div className="welcome-eyebrow">A LITTLE SPACE TO GET THINGS DONE</div><h2>What are we working on?</h2><p>Bring your files and a question. I can explore data,<br className="desktop-break" /> create documents, and help turn the details into something useful.</p><div className="suggestions"><button type="button" onClick={() => { changeDraft(draftKey, draft => ({ ...draft, text: 'Inspect my uploaded files and summarize the key findings.' })); textRef.current?.focus(); }}><FileText size={18} /><strong>Make sense of a document</strong><span>Find the details that matter</span><ChevronRight size={16} /></button><button type="button" onClick={() => { changeDraft(draftKey, draft => ({ ...draft, text: 'Analyze my uploaded spreadsheet, check the totals, and create a summary workbook.' })); textRef.current?.focus(); }}><FileSpreadsheet size={18} /><strong>Work through a spreadsheet</strong><span>Check, calculate, and organize</span><ChevronRight size={16} /></button></div><div className="welcome-note"><FolderOpen size={14} />Files stay available across your conversations.</div></section> : <div className="messages">{messages.map(message => <MessageView key={message.id} message={message} files={files} live={live} onPreview={setPreviewFile} now={now} />)}</div>}
        </div>
      </div>
      {scrolledAway && messages.length > 0 && <button type="button" className="scroll-bottom-button" aria-label="Scroll to latest message" onClick={() => { setScrolledAway(false); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }}><ArrowDown size={17} /></button>}
      <div className="composer-area">
        {error && <ErrorNotice error={error} onDismiss={() => setError(null)} />}
        {busy && !activeHere && <div className="busy-banner"><LoaderCircle size={14} className="spin" /><span>{workflowExecution ? 'A workflow case is using the shared execution slot.' : sharedExecution?.kind === 'authoring' ? 'A workflow draft is being authored in the shared execution slot.' : 'Another conversation is working in the shared workspace.'}</span>{workflowExecution ? <button type="button" onClick={() => { localStorage.setItem('office.workflow-case', workflowExecution.id); setPage('cases'); }}>View case<ChevronRight size={13} /></button> : sharedExecution?.kind === 'authoring' ? <button type="button" onClick={() => setPage('create')}>View drafts<ChevronRight size={13} /></button> : <button type="button" onClick={() => live && chooseChat(live.run.chatId)}>View run<ChevronRight size={13} /></button>}</div>}
        <form className={`composer ${dragging ? 'dragging' : ''}`} onSubmit={event => void send(event)}>
          {(draft.attachments.length > 0 || draft.uploads > 0) && <div className="draft-attachments">{draft.attachments.map(file => <div key={file.path} className="attachment-chip"><FileGlyph file={file} size={17} /><span><strong>{file.name}</strong><small>{bytes(file.size)}</small></span><button className="icon-button" type="button" aria-label={`Remove ${file.name}`} onClick={() => changeDraft(draftKey, draft => ({ ...draft, attachments: draft.attachments.filter(item => item.path !== file.path) }))}><X size={14} /></button></div>)}{draft.uploads > 0 && <div className="attachment-uploading"><LoaderCircle className="spin" size={15} />Uploading files…</div>}</div>}
          <textarea ref={textRef} rows={1} value={draft.text} placeholder="Ask anything, or drop in a file…" aria-label="Message T-force" onChange={event => changeDraft(draftKey, draft => ({ ...draft, text: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
          <div className="composer-toolbar"><input ref={fileInput} type="file" multiple hidden onChange={event => { if (event.target.files) void upload(event.target.files); event.target.value = ''; }} /><button type="button" className="attach-button" onClick={() => fileInput.current?.click()} aria-label="Attach files"><Paperclip size={18} /><span>Attach files</span></button><span className="composer-hint">Shift + Enter for a new line</span>{activeHere ? <button type="button" className="stop-button" onClick={() => void stop()} disabled={stopping}>{stopping ? <LoaderCircle size={15} className="spin" /> : <Square size={13} fill="currentColor" />}<span>{stopping ? 'Stopping' : 'Stop'}</span></button> : <button type="submit" className="send-button" aria-label="Send message" disabled={sending || busy || draft.uploads > 0 || !ready || (!draft.text.trim() && !draft.attachments.length)}>{sending ? <LoaderCircle className="spin" size={19} /> : <ArrowUp size={21} />}</button>}</div>
        </form>
        <div className="composer-footer"><span><span className="status-dot" />{health?.model ?? 'GPT-6 Luna'}{chatBusy && live && <> <span className="meta-divider">·</span> <Clock3 size={11} />{elapsed(live.run.startedAt, live.run.finishedAt, now)}{live.run.usage.totalTokens > 0 && <> <span className="meta-divider">·</span> {live.run.usage.totalTokens.toLocaleString()} tokens</>}</>}</span><span title="Relevant document content is sent to your configured Azure model.">Local execution · Azure AI</span></div>
      </div>
      {dragging && <div className="drop-overlay"><div><UploadCloud size={39} strokeWidth={1.6} /><h3>Drop your files here</h3><p>Up to {bytes(health?.limits.fileBytes ?? 25 * 1024 * 1024)} per file</p></div></div>}
    </main>

    {workspaceOpen && <aside className="workspace-panel"><header><div><FolderOpen size={19} /><h2>Workspace</h2></div><button type="button" className="icon-button" aria-label="Close workspace" onClick={() => setWorkspaceOpen(false)}><PanelRightClose size={17} /></button></header><div className="workspace-intro"><span className="shared-label">SHARED ACROSS CONVERSATIONS</span><p>Your inputs and everything created along the way.</p></div><label className="file-search"><Search size={15} /><input type="search" value={fileFilter} onChange={event => setFileFilter(event.target.value)} placeholder="Find a file…" aria-label="Search workspace files" /></label><div className="files-heading"><span>Files <small>{files.length}</small></span><button className="icon-button" type="button" onClick={() => void refreshFiles()} disabled={refreshingFiles} aria-label="Refresh workspace files"><RefreshCw size={14} className={refreshingFiles ? 'spin' : ''} /></button></div>{workspaceError && <div className="workspace-error"><ErrorNotice error={workspaceError} /></div>}<div className="file-list">{filteredFiles.map(file => <div className="workspace-file" key={file.path}><button type="button" className="workspace-file-open" onClick={() => setPreviewFile(file)} title={file.path}><span className={`workspace-file-icon ${isOutput(file) ? 'output-icon' : ''}`}><FileGlyph file={file} size={20} /></span><span><strong>{file.name}</strong><small>{isOutput(file) ? 'Output' : isUpload(file) ? 'Upload' : 'Workspace'} <span>·</span> {bytes(file.size)}</small></span></button><a href={fileURL('download', file.path)} download={file.name} className="icon-button file-download" aria-label={`Download ${file.name}`}><ArrowDownToLine size={15} /></a></div>)}{!filteredFiles.length && <div className="empty-files"><div><FolderOpen size={26} strokeWidth={1.4} /></div><strong>{fileFilter ? 'No matching files' : 'Room for your work'}</strong><p>{fileFilter ? 'Try another name or path.' : 'Upload a file to get started. Generated files will appear here, too.'}</p>{!fileFilter && <button type="button" onClick={() => fileInput.current?.click()}><Plus size={14} />Upload a file</button>}</div>}</div><div className="workspace-bottom"><HardDrive size={14} /><span>/workspace</span><span>{bytes(files.reduce((sum, file) => sum + file.size, 0))}</span></div></aside>}
    {previewFile && <PreviewDialog file={previewFile} onClose={closePreview} />}
  </div>;
}
