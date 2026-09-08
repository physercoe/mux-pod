import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '../bridge';
import { useT, tStatic } from '../i18n';
import { isShell, revealPath } from '../platform';
import { useCompanionContext } from '../state/companionContext';
import { toast } from '../state/toast';
import {
  bodyToFile,
  extForDoc,
  extForKind,
  fileToBody,
  fingerprintBody,
  kindForFile,
  seedBody,
  useDocuments,
  type Doc,
  type DocKind,
} from '../state/documents';
import { agentEditCount, agentEditTitle, latestAgentEdit, useAgentEdits } from '../state/agentEdits';
import { figureBySpec, FIGURES, type FigureSpec } from '../state/figures';
import { liveApply } from '../state/liveApply';
import { useWorkspace } from '../state/workspace';
import { NEW_BASE, uniqueWorkspacePath, writeDocToWorkspace } from '../state/workspaceFiles';
import { useContextMenu, type MenuItem } from '../ui/ContextMenu';
import { docKindIcon, Icon, type IconName } from '../ui/Icon';
import { useTextPrompt } from '../ui/PromptModal';
import { AuthorNav } from './AuthorNav';
import { DiagramEditor } from './DiagramEditor';
// The canvas board pulls in React Flow (a few hundred KB) — split it out so the
// dependency loads only when a board is opened, never at app boot.
const CanvasEditor = lazy(() => import('../ui/CanvasEditor').then((m) => ({ default: m.CanvasEditor })));
import { Markdown, slugify } from '../ui/Markdown';
import { extractHeadings, MarkdownOutline, type Head } from '../ui/MarkdownOutline';
// The table/database grid is only pulled in when a table doc is opened.
const TableEditor = lazy(() => import('../ui/TableEditor').then((m) => ({ default: m.TableEditor })));
// The figure editor pulls in a renderer library (mermaid/graphviz/vega) on first
// use of a spec — split it (and them) out of the entry chunk.
const FigureEditor = lazy(() => import('./FigureEditor').then((m) => ({ default: m.FigureEditor })));
// Excalidraw is a heavy interactive editor (its own React tree + fonts) — split
// it out so it loads only when a sketch doc is opened, never at app boot.
const ExcalidrawEditor = lazy(() => import('./ExcalidrawEditor').then((m) => ({ default: m.ExcalidrawEditor })));
import type { MarkdownEditorHandle } from '../ui/MarkdownEditor';
// CodeMirror is heavy (~500 KB) and Author isn't the landing tab — split it out.
const MarkdownEditor = lazy(() => import('../ui/MarkdownEditor').then((m) => ({ default: m.MarkdownEditor })));
const WysiwygEditor = lazy(() => import('../ui/WysiwygEditor').then((m) => ({ default: m.WysiwygEditor })));
import { ResizeHandle } from '../ui/ResizeHandle';
import { HeaderPaneToggle, WorkbenchSurface } from '../ui/WorkbenchSurface';
import { PopoverMenu } from '../ui/PopoverMenu';

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
function loadW(key: string, fallback: number): number {
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/// A trailing-debounced mirror of a value. The split/read Markdown preview
/// re-parses the WHOLE document (react-markdown + rehype-highlight + KaTeX) on
/// every editor keystroke — a main-thread stall on large docs (#311). Debouncing
/// the preview's input coalesces a typing burst into one parse (~250ms, in step
/// with the documents store's 400ms trailing persistence) while the editor
/// itself keeps the live value.
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

/// J2 — Author reports / slides / figures. A workspace of **multiple documents
/// as tabs** (director request), each a split GFM+math+code Markdown editor
/// (source ↔ live preview) over the shared `Markdown` renderer (KaTeX +
/// highlight.js, offline).
///
/// Storage: documents are device-local (localStorage) by default and can be
/// saved to a real file on disk via the native dialog — the header shows where
/// the active document lives. The landscape doc's posture is EMBED BlockNote +
/// Quarto/Typst export for the reproducible-report path; a draw.io `diagram`
/// document kind lands once drawio is bundled offline (see the
/// author-agent-assist-and-diagrams discussion). Agent-assisted writing lives
/// in the unified assistant dock's Companion tab — this surface feeds it the
/// active document's context through the provider registry
/// (state/companionContext.ts).

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function extOf(path: string): string {
  return path.split('.').pop()?.toLowerCase() ?? '';
}

/// Keep a file's extension through a tab rename: if the typed name already has an
/// extension it's used verbatim, otherwise the reference file's extension is
/// appended so renaming "report" a `.md` doc doesn't drop the `.md`.
function withExt(name: string, refPath: string): string {
  if (/\.[a-z0-9]{1,8}$/i.test(name)) return name;
  const ext = refPath.split('.').pop();
  return ext !== undefined && ext !== refPath ? `${name}.${ext}` : name;
}

/// Strip a single enclosing ```` ``` ```` fence from an agent reply so a figure
/// body stays raw source. Agents answer "a sequence diagram of X" with a fenced
/// ```` ```mermaid … ``` ```` block; the figure renderer wants the inside only.
/// A reply that isn't a lone fence passes through untouched.
function unfence(text: string): string {
  const m = /^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/.exec(text.trim());
  return m !== null ? m[1] : text;
}

type ViewMode = 'wysiwyg' | 'edit' | 'split' | 'read';

function Editor({ doc }: { doc: Doc }): JSX.Element {
  const t = useT();
  const update = useDocuments((s) => s.update);
  const edRef = useRef<MarkdownEditorHandle>(null);
  // The `.author-body` element — the outline routes preview scroll + the
  // best-effort wysiwyg jump by querying inside it.
  const bodyElRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<ViewMode>(() => {
    const v = localStorage.getItem('termipod.author.viewMode');
    return v === 'wysiwyg' || v === 'edit' || v === 'split' || v === 'read' ? v : 'split';
  });
  function pickMode(m: ViewMode): void {
    setMode(m);
    try {
      localStorage.setItem('termipod.author.viewMode', m);
    } catch {
      /* ignore */
    }
  }
  const [softWrap, setSoftWrap] = useState(() => localStorage.getItem('termipod.author.softWrap') !== 'false');
  function toggleWrap(): void {
    const next = !softWrap;
    setSoftWrap(next);
    try {
      localStorage.setItem('termipod.author.softWrap', String(next));
    } catch {
      /* ignore */
    }
  }
  const words = doc.body.trim() ? doc.body.trim().split(/\s+/).length : 0;
  // The preview renders the debounced body, not the per-keystroke one (#311); the
  // outline recomputes from the same debounced body, not per keystroke.
  const previewBody = useDebounced(doc.body, 250);
  const headings = useMemo(() => extractHeadings(previewBody), [previewBody]);

  // Route an outline click by view mode: the source editor jumps its selection to
  // the heading's line (edit/split), the preview scrolls to the stamped id
  // (read/split), and wysiwyg is best-effort (Crepe stamps no ids — match a
  // rendered heading by slugified text; a miss is a no-op).
  const onJump = useCallback(
    (h: Head): void => {
      if (mode === 'edit' || mode === 'split') edRef.current?.revealLine(h.line);
      if (mode === 'read' || mode === 'split') {
        const sel = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(h.slug) : h.slug;
        bodyElRef.current?.querySelector(`.preview-pane #${sel}`)?.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
      if (mode === 'wysiwyg') {
        const host = bodyElRef.current;
        if (host !== null) {
          const hs = host.querySelectorAll('.milkdown h1, .milkdown h2, .milkdown h3, .milkdown h4, .milkdown h5, .milkdown h6');
          for (const el of Array.from(hs)) {
            if (slugify(el.textContent ?? '') === h.slug) {
              el.scrollIntoView({ behavior: 'auto', block: 'start' });
              break;
            }
          }
        }
      }
    },
    [mode],
  );

  // Formatting actions act on the live CodeMirror selection (mousedown-preventDefault
  // keeps that selection alive through the button click).
  const fmt: { icon: IconName; title: string; run: () => void }[] = [
    { icon: 'bold', title: t('author.fmtBold'), run: () => edRef.current?.wrap('**') },
    { icon: 'italic', title: t('author.fmtItalic'), run: () => edRef.current?.wrap('*') },
    { icon: 'code', title: t('author.fmtCode'), run: () => edRef.current?.wrap('`') },
    { icon: 'heading', title: t('author.fmtHeading'), run: () => edRef.current?.linePrefix('## ') },
    { icon: 'list', title: t('author.fmtList'), run: () => edRef.current?.linePrefix('- ') },
    { icon: 'list-ordered', title: t('author.fmtOList'), run: () => edRef.current?.linePrefix('1. ') },
    { icon: 'quote', title: t('author.fmtQuote'), run: () => edRef.current?.linePrefix('> ') },
    { icon: 'link', title: t('author.fmtLink'), run: () => edRef.current?.wrap('[', '](url)') },
  ];

  return (
    <div className="author-doc">
      <div className="author-doc-bar">
        <div className="seg author-viewmode">
          {(['wysiwyg', 'edit', 'split', 'read'] as ViewMode[]).map((m) => (
            <button key={m} className={mode === m ? 'seg-btn active' : 'seg-btn'} onClick={() => pickMode(m)}>
              {t(`author.mode_${m}`)}
            </button>
          ))}
        </div>
        {(mode === 'edit' || mode === 'split') && (
          <div className="author-fmt">
            {fmt.map((f) => (
              <button
                key={f.title}
                className="author-fmt-btn"
                title={f.title}
                onMouseDown={(e) => e.preventDefault()}
                onClick={f.run}
              >
                <Icon name={f.icon} size={15} />
              </button>
            ))}
          </div>
        )}
        <button
          className={`icon-btn${softWrap ? ' active' : ''}`}
          title={t('inspect.wrap')}
          aria-label={t('inspect.wrap')}
          aria-pressed={softWrap}
          onClick={toggleWrap}
        >
          <Icon name="wrap" size={15} />
        </button>
        <span className="spacer" />
        <span className="author-doc-meta muted small">
          {t.plural('author.words', words)}
          {doc.filePath !== undefined ? (
            <span title={doc.filePath}>
              {' · '}
              {doc.dirty === true ? '● ' : ''}
              {t('author.savedFile').replace('{f}', baseName(doc.filePath))}
            </span>
          ) : (
            <span title={t('author.savedLocalHint')}>{' · '}{t('author.savedLocal')}</span>
          )}
        </span>
      </div>
      <div className={`author-body mode-${mode}${softWrap ? ' soft-wrap' : ''}`} ref={bodyElRef}>
        {mode === 'wysiwyg' ? (
          <Suspense fallback={<div className="milkdown-host muted region-pad">{t('author.loadingEditor')}</div>}>
            <WysiwygEditor
              key={doc.id}
              value={doc.body}
              onChange={(v) => update(doc.id, { body: v })}
              placeholder={t('author.placeholder')}
            />
          </Suspense>
        ) : (
          <>
            {mode !== 'read' && (
              <Suspense fallback={<div className="md-editor muted region-pad">{t('author.loadingEditor')}</div>}>
                <MarkdownEditor
                  ref={edRef}
                  softWrap={softWrap}
                  value={doc.body}
                  onChange={(v) => update(doc.id, { body: v })}
                  placeholder={t('author.placeholder')}
                />
              </Suspense>
            )}
            {mode !== 'edit' && (
              <div className="preview-pane">
                {previewBody.trim() ? (
                  <Markdown text={previewBody} headingIds />
                ) : (
                  <div className="muted region-pad">{t('author.empty')}</div>
                )}
              </div>
            )}
          </>
        )}
        {/* Obsidian-style outline on the right, in every view mode. Hidden when
            ≤ 1 heading (the shared rail's own rule). */}
        <MarkdownOutline
          headings={headings}
          bodyRef={bodyElRef}
          widthKey="termipod.author.outlineW"
          foldKey="termipod.author.outlineOpen"
          side="right"
          onJump={onJump}
        />
      </div>
    </div>
  );
}

/// One row of the categorized "New ▾" menu — a leading kind icon + label that
/// closes the menu and creates the document.
function NewItem({
  icon,
  label,
  onPick,
  close,
}: {
  icon: IconName;
  label: string;
  onPick: () => void;
  close: () => void;
}): JSX.Element {
  return (
    <button
      role="menuitem"
      className="author-figmenu-item"
      onClick={() => {
        close();
        onPick();
      }}
    >
      <Icon name={icon} size={14} />
      {label}
    </button>
  );
}

export function AuthorSurface(): JSX.Element {
  const t = useT();
  const docs = useDocuments((s) => s.docs);
  const activeId = useDocuments((s) => s.activeId);
  const create = useDocuments((s) => s.create);
  const remove = useDocuments((s) => s.remove);
  const setActive = useDocuments((s) => s.setActive);
  const markSaved = useDocuments((s) => s.markSaved);
  const replaceFromDisk = useDocuments((s) => s.replaceFromDisk);
  const acceptDiskFingerprint = useDocuments((s) => s.acceptDiskFingerprint);
  const update = useDocuments((s) => s.update);
  // B6: which documents an agent has written to, and their pre-write bodies.
  const agentEdits = useAgentEdits((s) => s.byDoc);
  const clearAgentEdits = useAgentEdits((s) => s.clear);
  const folder = useWorkspace((s) => s.folder);
  const touchWs = useWorkspace((s) => s.touch);
  const { ask, node: promptNode } = useTextPrompt();
  const { open: openTabMenu, node: tabMenuNode } = useContextMenu();
  const [busy, setBusy] = useState(false);
  // Left file/workspace tree. On by default; width persisted.
  const [showNav, setShowNav] = useState(() => localStorage.getItem('termipod.author.showNav') !== '0');
  const [navW, setNavW] = useState(() => loadW('termipod.author.navW', 240));
  // Two-step close is reserved for content that can actually be lost: an
  // in-memory draft or unsaved edits. A clean file-backed tab closes directly —
  // closing the view does not delete its file.
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  // The categorized "New ▾" dropdown — one menu for every document kind (Write /
  // Data / Draw / Figure), the figure rows driven by the `FIGURES` registry.
  const [newMenu, setNewMenu] = useState(false);
  const newMenuAnchorRef = useRef<HTMLDivElement>(null);
  const tabStripRef = useRef<HTMLDivElement>(null);
  const [tabOverflow, setTabOverflow] = useState({ overflowing: false, before: false, after: false });
  const [diskConflicts, setDiskConflicts] = useState<Record<string, { body: string; fingerprint: string }>>({});
  const [compareConflictId, setCompareConflictId] = useState<string | null>(null);
  const docsRef = useRef(docs);
  docsRef.current = docs;

  const active = docs.find((d) => d.id === activeId);
  const tauri = isShell();

  // Keep every linked Author tab synchronized with its local file, including
  // while another surface is selected. A clean tab reloads automatically. If
  // the user has unsaved edits, preserve both versions and ask which one wins.
  useEffect(() => {
    if (!tauri) return;
    let stopped = false;
    let running = false;
    async function refreshLinkedFiles(): Promise<void> {
      if (running || document.visibilityState === 'hidden') return;
      running = true;
      try {
        await Promise.all(
          docsRef.current.map(async (snapshot) => {
            if (snapshot.filePath === undefined) return;
            try {
              const res = await invoke<{ path: string; content: string }>('doc_read', { path: snapshot.filePath });
              if (stopped) return;
              const ext = extOf(snapshot.filePath);
              const diskBody = fileToBody(snapshot.kind, res.content, ext, tStatic('table.colName'));
              const diskFingerprint = fingerprintBody(diskBody);
              const current = useDocuments.getState().docs.find((d) => d.id === snapshot.id);
              if (current === undefined || current.filePath !== snapshot.filePath) return;

              // One-time migration for tabs opened before fingerprints existed.
              if (current.fileFingerprint === undefined) {
                if (current.dirty !== true && diskFingerprint !== fingerprintBody(current.body)) {
                  replaceFromDisk(current.id, diskBody, diskFingerprint);
                  liveApply(current.id, diskBody);
                } else {
                  acceptDiskFingerprint(current.id, diskFingerprint);
                }
                return;
              }
              if (diskFingerprint === current.fileFingerprint) {
                setDiskConflicts((all) => {
                  if (all[current.id] === undefined) return all;
                  const next = { ...all };
                  delete next[current.id];
                  return next;
                });
              } else if (current.dirty === true) {
                setDiskConflicts((all) => ({ ...all, [current.id]: { body: diskBody, fingerprint: diskFingerprint } }));
              } else {
                replaceFromDisk(current.id, diskBody, diskFingerprint);
                liveApply(current.id, diskBody);
                setDiskConflicts((all) => {
                  if (all[current.id] === undefined) return all;
                  const next = { ...all };
                  delete next[current.id];
                  return next;
                });
              }
            } catch {
              // A temporarily unavailable/deleted file must not discard the
              // cached document. The next poll retries naturally.
            }
          }),
        );
      } finally {
        running = false;
      }
    }
    void refreshLinkedFiles();
    const timer = window.setInterval(() => void refreshLinkedFiles(), 2000);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void refreshLinkedFiles();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [acceptDiskFingerprint, replaceFromDisk, tauri]);

  // Document tabs keep a useful, stable width instead of shrinking into a row
  // of indistinguishable file icons. Track the scroll edges so compact previous /
  // next controls appear only when the strip genuinely overflows.
  const measureTabOverflow = useCallback((): void => {
    const el = tabStripRef.current;
    if (el === null) return;
    const max = Math.max(0, el.scrollWidth - el.clientWidth);
    // `scrollIntoView({ inline: 'nearest' })` may stop at the strip's 7px
    // inline padding rather than literal zero; treat that optical gutter as an
    // edge so a control never looks actionable when every tab is already shown.
    const edgeSlack = 8;
    const next = {
      overflowing: max > 1,
      before: el.scrollLeft > edgeSlack,
      after: el.scrollLeft < max - edgeSlack,
    };
    setTabOverflow((prev) =>
      prev.overflowing === next.overflowing && prev.before === next.before && prev.after === next.after ? prev : next,
    );
  }, []);

  useEffect(() => {
    const el = tabStripRef.current;
    if (el === null) return;
    const frame = window.requestAnimationFrame(measureTabOverflow);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measureTabOverflow) : null;
    observer?.observe(el);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [docs.length, measureTabOverflow]);

  // Opening or selecting a document should never leave its tab hidden beyond
  // an overflow edge. `nearest` moves the strip only as far as necessary.
  useEffect(() => {
    const el = tabStripRef.current;
    if (el === null || activeId === null) return;
    const frame = window.requestAnimationFrame(() => {
      const tab = Array.from(el.children).find((child) => (child as HTMLElement).dataset.docId === activeId);
      tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      measureTabOverflow();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeId, docs.length, measureTabOverflow]);

  function scrollTabs(direction: -1 | 1): void {
    const el = tabStripRef.current;
    if (el === null) return;
    el.scrollBy({ left: direction * Math.max(180, el.clientWidth * 0.72), behavior: 'smooth' });
  }

  function moveTabFocus(e: React.KeyboardEvent<HTMLDivElement>): void {
    const target = e.target as HTMLElement;
    if (target.getAttribute('role') !== 'tab' || docs.length === 0) return;
    const current = docs.findIndex((d) => d.id === activeId);
    let next = current < 0 ? 0 : current;
    if (e.key === 'ArrowRight') next = (next + 1) % docs.length;
    else if (e.key === 'ArrowLeft') next = (next - 1 + docs.length) % docs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = docs.length - 1;
    else return;
    e.preventDefault();
    setActive(docs[next].id);
    window.requestAnimationFrame(() => {
      const strip = tabStripRef.current;
      const tab = strip === null ? undefined : Array.from(strip.children).find((child) => (child as HTMLElement).dataset.docId === docs[next].id);
      tab?.querySelector<HTMLElement>('[role="tab"]')?.focus();
    });
  }

  // The dock companion's context provider (the unified assistant dock, D2.2 —
  // state/companionContext.ts): the active document. Register on mount +
  // active-document change, unregister on unmount / no active document (the
  // sanctioned no-focus-event approximation). `build`/`insert` read the
  // documents store LIVE at call time, so the effect re-runs only when the
  // label/kind changes, not on every keystroke. Insert semantics: prose
  // APPENDS to a markdown body and REPLACES a figure body (a figure is a
  // single spec source — an append would corrupt it; the agent answers with
  // the whole diagram, `unfence`d). A diagram/canvas/table body is structured
  // (XML/JSON) with no safe text insert, so no `insert` is registered for it.
  const registerCtx = useCompanionContext((s) => s.register);
  const unregisterCtx = useCompanionContext((s) => s.unregister);
  const activeTitle = active?.title;
  const activeKind = active?.kind;
  useEffect(() => {
    if (activeId === null) {
      unregisterCtx('author');
      return;
    }
    const id = activeId;
    const live = (): Doc | undefined => useDocuments.getState().docs.find((d) => d.id === id);
    registerCtx('author', {
      label: activeTitle !== undefined && activeTitle !== '' ? activeTitle : tStatic('author.untitled'),
      build: () => {
        const d = live();
        if (d === undefined) return '';
        return d.kind === 'markdown'
          ? `I'm writing a document titled "${d.title}". Current draft:\n\n${d.body}`
          : d.kind === 'figure'
            ? `I'm authoring a ${d.spec ?? 'figure'} diagram titled "${d.title}", rendered from the \`\`\`${d.spec ?? ''}\`\`\` fenced syntax. Reply with ONLY the ${d.spec ?? 'figure'} source (optionally in a fenced block). Current source:\n\n${d.body}`
            : `I'm editing a ${d.kind} document titled "${d.title}"${
                d.filePath !== undefined ? ` (file: ${d.filePath})` : ''
              }.`;
      },
      ...(activeKind === 'markdown' || activeKind === 'figure'
        ? {
            insert: (text: string) => {
              const d = live();
              if (d === undefined) return;
              if (d.kind === 'markdown') {
                useDocuments.getState().update(id, {
                  body: d.body.trimEnd() === '' ? text : `${d.body.trimEnd()}\n\n${text}`,
                });
              } else if (d.kind === 'figure') {
                useDocuments.getState().update(id, { body: unfence(text) });
              }
            },
          }
        : {}),
    });
  }, [activeId, activeTitle, activeKind, registerCtx, unregisterCtx]);
  // Unmount removal lives in its own effect — riding the registration effect's
  // cleanup would turn every re-register into remove+append churn.
  useEffect(() => () => unregisterCtx('author'), [unregisterCtx]);

  // Fold state for the workspace pane (persisted); one fixed surface-header
  // control both hides and restores it.
  function setNav(next: boolean): void {
    setShowNav(next);
    try {
      localStorage.setItem('termipod.author.showNav', next ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  function closeNeedsConfirm(d: Doc | undefined): boolean {
    if (d === undefined) return false;
    const body = d.body.trim();
    const hasContent = body !== '' && body !== '#';
    return hasContent && (d.filePath === undefined || d.dirty === true);
  }

  function closeTab(id: string): void {
    const d = docs.find((x) => x.id === id);
    if (closeNeedsConfirm(d) && confirmClose !== id) {
      setConfirmClose(id);
      return;
    }
    setConfirmClose(null);
    clearAgentEdits(id);
    remove(id);
  }

  /// B6: put back the document as it was before the last agent write.
  ///
  /// Both halves are needed. The store write is what the document IS, and it is
  /// enough for kinds whose editor re-renders from `body`; the live-apply pass
  /// is what a vendor editor needs, because draw.io and the canvas board own
  /// their state once mounted and would otherwise keep showing the agent's
  /// version over a store that no longer holds it. `liveApply` answers
  /// `no_target` for a document that is not the mounted editor, which is the
  /// ordinary case when reverting from another tab — nothing to do there,
  /// because mounting it later reads the reverted `body`.
  function revertAgentEdit(id: string): void {
    const before = useAgentEdits.getState().revert(id);
    if (before === null) return;
    update(id, { body: before });
    liveApply(id, before);
  }

  // Materialize a draft tab into the workspace folder (the same path AuthorNav's
  // drop handler uses when a draft tab is dragged onto the tree). Drafts only.
  async function saveDraftToWorkspace(id: string): Promise<void> {
    const d = docs.find((x) => x.id === id);
    if (folder === null || d === undefined || d.filePath !== undefined) return;
    try {
      const path = await writeDocToWorkspace(folder, d);
      markSaved(id, path, baseName(path));
      touchWs();
    } catch {
      /* permissions / race — leave the draft in memory */
    }
  }

  // Rename a document from its tab. A draft — or a file-backed doc that lives
  // outside the open workspace — just retitles; a file inside the workspace is
  // renamed on disk (`workspace_rename`) and the doc re-pointed so Save keeps
  // round-tripping to it.
  async function renameDoc(id: string): Promise<void> {
    const d = docs.find((x) => x.id === id);
    if (d === undefined) return;
    const name = await ask(t('author.renamePrompt'), d.title);
    if (name === null || name.trim() === '' || name.trim() === d.title) return;
    const nm = name.trim();
    if (d.filePath !== undefined && folder !== null && d.filePath.startsWith(folder)) {
      try {
        const next = await invoke<string>('workspace_rename', { path: d.filePath, name: withExt(nm, d.filePath) });
        update(d.id, { filePath: next, title: baseName(next) });
        touchWs();
      } catch (e) {
        toast.error(t('author.fOpFailed').replace('{err}', e instanceof Error ? e.message : String(e)));
      }
      return;
    }
    update(d.id, { title: nm });
  }

  async function onSave(): Promise<void> {
    if (active === undefined || !tauri) return;
    setBusy(true);
    try {
      // The disk format follows the target file's extension (a table re-saves as
      // CSV if linked to a .csv, else the lossless .json default). A figure saves
      // as its spec's extension (`extForDoc`).
      const ext = active.filePath !== undefined ? extOf(active.filePath) : extForDoc(active);
      const content = bodyToFile(active.kind, active.body, ext, t('table.colName'));
      if (active.filePath !== undefined) {
        // Re-read immediately before writing as well as polling. This closes the
        // race where an external editor saves between two background checks.
        const disk = await invoke<{ path: string; content: string }>('doc_read', { path: active.filePath });
        const diskBody = fileToBody(active.kind, disk.content, ext, t('table.colName'));
        const diskFingerprint = fingerprintBody(diskBody);
        if (active.fileFingerprint !== undefined && diskFingerprint !== active.fileFingerprint) {
          setDiskConflicts((all) => ({ ...all, [active.id]: { body: diskBody, fingerprint: diskFingerprint } }));
          toast.error(t('author.externalSaveBlocked'));
          return;
        }
        await invoke('doc_write', { path: active.filePath, content });
        markSaved(active.id, active.filePath);
        setDiskConflicts((all) => {
          if (all[active.id] === undefined) return all;
          const next = { ...all };
          delete next[active.id];
          return next;
        });
      } else {
        const name = (active.title !== '' ? active.title : 'document').replace(/[^\w.-]+/g, '-');
        const path = await invoke<string | null>('doc_save', {
          content,
          defaultName: `${name}.${extForDoc(active)}`,
        });
        if (path !== null) markSaved(active.id, path, baseName(path));
      }
      toast.success(t('author.saved'));
    } catch (e) {
      // Was silently swallowed — a failed disk write left the ● dirty dot with no
      // explanation. Surface it (#312/#315); the doc stays dirty so a retry works.
      toast.error(`${t('author.saveFailed')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  // Cmd/Ctrl+S saves the active document to its linked file (browser build / no
  // active doc: a no-op, guarded inside onSave). A ref keeps the handler pointed
  // at the latest closure without re-subscribing the listener each keystroke.
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveRef.current();
      } else if (e.key === 'Escape') {
        setNewMenu(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Create a new document. With a workspace folder open (desktop), it's
  // materialized as a real file IN that folder — so it appears in the tree and
  // round-trips on Save — instead of a device-local draft disconnected from the
  // workspace (director report: "the file is not added to the workspace"). With
  // no folder open, or in the browser build, it stays an in-memory draft.
  // A figure carries a `spec` (which renderer): its seed body and on-disk
  // extension come from the registry row, not the bare kind.
  async function createDoc(kind: DocKind, spec?: FigureSpec): Promise<void> {
    const row = spec !== undefined ? figureBySpec(spec) : undefined;
    const seed: Partial<Doc> = spec !== undefined ? { spec, body: row?.sample ?? '' } : {};
    if (!tauri || folder === null) {
      create(kind, seed);
      return;
    }
    setBusy(true);
    try {
      const ext = row?.ext ?? extForKind(kind);
      const body = seed.body ?? seedBody(kind);
      const path = await uniqueWorkspacePath(folder, NEW_BASE[kind], ext);
      await invoke('doc_write', { path, content: bodyToFile(kind, body, ext, t('table.colName')) });
      create(kind, { ...seed, title: baseName(path), body, filePath: path });
      touchWs();
    } catch {
      // Permissions / race — still give the user a document, just in-memory.
      create(kind, seed);
    } finally {
      setBusy(false);
    }
  }

  async function onOpen(): Promise<void> {
    if (!tauri) return;
    setBusy(true);
    try {
      const res = await invoke<{ path: string; content: string } | null>('doc_open');
      if (res !== null) {
        const ext = extOf(res.path);
        const { kind, spec } = kindForFile(ext, res.content);
        create(kind, {
          title: baseName(res.path),
          body: fileToBody(kind, res.content, ext, t('table.colName')),
          filePath: res.path,
          spec,
        });
      }
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  }

  return (
    <WorkbenchSurface
      job="author"
      leadingPaneWidth={showNav ? navW : 0}
      leadingActions={
        <HeaderPaneToggle
          side="left"
          open={showNav}
          showLabel={t('author.filesShow')}
          hideLabel={t('author.navFold')}
          onToggle={() => setNav(!showNav)}
        />
      }
      actions={
        <>
          <div ref={newMenuAnchorRef} className="author-figbtn author-newbtn">
            {/* Primary = new Document (the common case); the caret opens the
                categorized menu. */}
            <button className="import-btn primary" disabled={busy} onClick={() => void createDoc('markdown')}>
              <Icon name="plus" size={14} />
              {t('author.newDoc')}
            </button>
            <button
              className="import-btn primary author-newcaret"
              disabled={busy}
              aria-haspopup="menu"
              aria-expanded={newMenu}
              title={t('author.newMenu')}
              onClick={() => setNewMenu((v) => !v)}
            >
              <Icon name="chevron-down" size={12} />
            </button>
            <PopoverMenu
              anchorRef={newMenuAnchorRef}
              open={newMenu}
              onClose={() => setNewMenu(false)}
              className="author-figmenu"
              ariaLabel={t('author.newMenu')}
            >
                  <div className="author-figmenu-group">{t('author.newGroupWrite')}</div>
                  <NewItem icon="note" label={t('author.newDoc')} onPick={() => void createDoc('markdown')} close={() => setNewMenu(false)} />
                  <div className="author-figmenu-group">{t('author.newGroupData')}</div>
                  <NewItem icon="table" label={t('author.newTable')} onPick={() => void createDoc('table')} close={() => setNewMenu(false)} />
                  <div className="author-figmenu-group">{t('author.newGroupDraw')}</div>
                  <NewItem icon="diagram" label={t('author.newDiagram')} onPick={() => void createDoc('diagram')} close={() => setNewMenu(false)} />
                  <NewItem icon="sketch" label={t('author.newExcalidraw')} onPick={() => void createDoc('excalidraw')} close={() => setNewMenu(false)} />
                  <NewItem icon="canvas" label={t('author.newCanvas')} onPick={() => void createDoc('canvas')} close={() => setNewMenu(false)} />
                  <div className="author-figmenu-group">{t('author.newGroupFigure')}</div>
                  {/* Registry-driven: a new figure spec appears here with no menu
                      change. bpmn-js stays unlisted while its license is held. */}
                  {FIGURES.map((f) => (
                    <NewItem
                      key={f.spec}
                      icon="figure"
                      label={t(f.labelKey)}
                      onPick={() => void createDoc('figure', f.spec)}
                      close={() => setNewMenu(false)}
                    />
                  ))}
            </PopoverMenu>
          </div>
          {tauri && (
            <>
              <button className="import-btn" disabled={busy} onClick={() => void onOpen()}>
                {t('author.openFile')}
              </button>
              <button className="import-btn" disabled={busy || active === undefined} onClick={() => void onSave()}>
                {active?.dirty === true ? '● ' : ''}
                {t('author.saveFile')}
              </button>
            </>
          )}
        </>
      }
    >
      <div className="author-layout">
      {showNav ? (
        <>
          <div className="author-nav-col" style={{ width: navW }}>
            <AuthorNav />
          </div>
          <ResizeHandle
            onResize={(dx) =>
              setNavW((w) => {
                const n = clamp(w + dx, 180, 480);
                try {
                  localStorage.setItem('termipod.author.navW', String(n));
                } catch {
                  /* ignore */
                }
                return n;
              })
            }
          />
        </>
      ) : null}
      <div className="author-main">
      {docs.length > 0 && (
        <div className="author-tabs-shell">
          {tabOverflow.overflowing && (
            <button
              className="author-tab-scroll before"
              aria-label={t('author.tabsScrollBack')}
              title={t('author.tabsScrollBack')}
              disabled={!tabOverflow.before}
              onClick={() => scrollTabs(-1)}
            >
              <Icon name="chevron-left" size={14} />
            </button>
          )}
          <div
            ref={tabStripRef}
            className="read-tabstrip author-doc-tabs"
            role="tablist"
            aria-label={t('author.docTabs')}
            onScroll={measureTabOverflow}
            onKeyDown={moveTabFocus}
          >
            {docs.map((d) => {
              const draft = d.filePath === undefined;
              const title = d.title !== '' ? d.title : t('author.untitled');
              const edit = latestAgentEdit(agentEdits, d.id);
              const editTitle = edit === undefined ? '' : agentEditTitle(edit, agentEditCount(agentEdits, d.id), t);
              const openTab = (e: { clientX: number; clientY: number; preventDefault: () => void }): void => {
                const items: MenuItem[] = [{ label: t('author.navRename'), onClick: () => void renameDoc(d.id) }];
                if (draft && folder !== null) {
                  items.push({ label: t('author.navSaveToWorkspace'), onClick: () => void saveDraftToWorkspace(d.id) });
                }
                if (!draft && tauri) {
                  const p = d.filePath as string;
                  items.push({ label: t('author.fReveal'), onClick: () => revealPath(p) });
                }
                items.push({
                  label: t('author.navClose'),
                  danger: closeNeedsConfirm(d),
                  onClick: () => closeTab(d.id),
                });
                openTabMenu(e, items);
              };
              return (
                <span
                  key={d.id}
                  role="presentation"
                  data-doc-id={d.id}
                  className={`read-tabitem${activeId === d.id ? ' active' : ''}`}
                >
                  <button
                    role="tab"
                    aria-selected={activeId === d.id}
                    tabIndex={activeId === d.id ? 0 : -1}
                    className="read-tabitem-label"
                    title={d.filePath ?? t('author.navDraftHint')}
                    draggable={draft}
                    onDragStart={
                      draft
                        ? (e) => {
                            e.dataTransfer.setData('application/x-termipod-doc', d.id);
                            e.dataTransfer.effectAllowed = 'copy';
                          }
                        : undefined
                    }
                    onClick={() => setActive(d.id)}
                    onContextMenu={openTab}
                  >
                    <Icon name={docKindIcon(d.kind)} size={13} className="read-tabitem-kind" />
                    {d.dirty === true && <span className="author-tab-dirty" aria-hidden="true" />}
                    <span className="author-tab-title">{title}</span>
                    {draft && <span className="read-tabitem-badge">{t('author.navDraft')}</span>}
                  </button>
                  {/* B6: attribution + one-click revert. Outside the tab button
                      (a button cannot nest one) so it is reachable without
                      switching to the tab — reverting a write on a document you
                      are not looking at is the common case when an agent works
                      across several. */}
                  {edit !== undefined && (
                    <button
                      className="read-tabitem-agent"
                      aria-label={editTitle}
                      title={editTitle}
                      onClick={() => revertAgentEdit(d.id)}
                    >
                      <Icon name="undo" size={11} />
                    </button>
                  )}
                  <button
                    className={confirmClose === d.id ? 'read-tabitem-x danger' : 'read-tabitem-x'}
                    aria-label={`${confirmClose === d.id ? t('author.confirmClose') : t('read.closeTab')}: ${title}`}
                    title={confirmClose === d.id ? t('author.confirmClose') : t('read.closeTab')}
                    onClick={() => closeTab(d.id)}
                  >
                    <Icon name={confirmClose === d.id ? 'check' : 'close'} size={12} />
                  </button>
                </span>
              );
            })}
          </div>
          {tabOverflow.overflowing && (
            <button
              className="author-tab-scroll after"
              aria-label={t('author.tabsScrollForward')}
              title={t('author.tabsScrollForward')}
              disabled={!tabOverflow.after}
              onClick={() => scrollTabs(1)}
            >
              <Icon name="chevron-right" size={14} />
            </button>
          )}
        </div>
      )}
      {active !== undefined ? (
        <div className="author-split">
          {diskConflicts[active.id] !== undefined && (
            <div className="author-file-conflict" role="alert">
              <Icon name="alert" size={16} />
              <span className="author-file-conflict-text">{t('author.externalChanged')}</span>
              <button
                type="button"
                onClick={() => {
                  const conflict = diskConflicts[active.id];
                  if (conflict === undefined) return;
                  replaceFromDisk(active.id, conflict.body, conflict.fingerprint);
                  liveApply(active.id, conflict.body);
                  setDiskConflicts((all) => {
                    const next = { ...all };
                    delete next[active.id];
                    return next;
                  });
                  setCompareConflictId(null);
                }}
              >
                {t('author.reloadDisk')}
              </button>
              <button type="button" onClick={() => setCompareConflictId((id) => (id === active.id ? null : active.id))}>
                {t('author.compareVersions')}
              </button>
              <button
                type="button"
                onClick={() => {
                  const conflict = diskConflicts[active.id];
                  if (conflict === undefined) return;
                  acceptDiskFingerprint(active.id, conflict.fingerprint);
                  setDiskConflicts((all) => {
                    const next = { ...all };
                    delete next[active.id];
                    return next;
                  });
                  setCompareConflictId(null);
                }}
              >
                {t('author.keepMine')}
              </button>
            </div>
          )}
          {compareConflictId === active.id && diskConflicts[active.id] !== undefined && (
            <div className="author-file-compare">
              <section>
                <strong>{t('author.diskVersion')}</strong>
                <pre>{diskConflicts[active.id].body}</pre>
              </section>
              <section>
                <strong>{t('author.myVersion')}</strong>
                <pre>{active.body}</pre>
              </section>
            </div>
          )}
          {active.kind === 'diagram' ? (
            <DiagramEditor key={active.id} doc={active} />
          ) : active.kind === 'canvas' ? (
            <Suspense fallback={<div className="muted region-pad">{t('author.loadingEditor')}</div>}>
              <CanvasEditor
                key={active.id}
                docId={active.id}
                value={active.body}
                onChange={(v) => update(active.id, { body: v })}
              />
            </Suspense>
          ) : active.kind === 'table' ? (
            <Suspense fallback={<div className="muted region-pad">{t('author.loadingEditor')}</div>}>
              <TableEditor key={active.id} value={active.body} onChange={(v) => update(active.id, { body: v })} />
            </Suspense>
          ) : active.kind === 'figure' ? (
            <Suspense fallback={<div className="muted region-pad">{t('author.loadingEditor')}</div>}>
              <FigureEditor key={active.id} doc={active} />
            </Suspense>
          ) : active.kind === 'excalidraw' ? (
            <Suspense fallback={<div className="muted region-pad">{t('author.loadingEditor')}</div>}>
              <ExcalidrawEditor key={active.id} doc={active} />
            </Suspense>
          ) : (
            <Editor key={active.id} doc={active} />
          )}
        </div>
      ) : (
        <div className="author-empty muted">
          <p>{t('author.noDocs')}</p>
          <button className="primary" onClick={() => create('markdown')}>
            + {t('author.newDoc')}
          </button>
        </div>
      )}
      </div>
      </div>
      {tabMenuNode}
      {promptNode}
    </WorkbenchSurface>
  );
}
