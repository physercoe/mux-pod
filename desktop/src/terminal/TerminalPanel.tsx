import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { Icon } from '../ui/Icon';
import { isShell } from '../platform';
import { useWorkbench } from '../state/workbench';
import {
  addGroup,
  connectionGroup,
  DEFAULT_GROUP,
  deleteConnection,
  getConnectionJumpPassword,
  getConnectionPassword,
  listConnections,
  navGroups,
  removeGroup,
  renameGroup,
  setConnectionGroup,
  touchConnection,
  type Connection,
} from '../state/connections';
import { exportSshConfig, importSshConfig } from '../ssh/config';
import { sshClose, sshConnect, sshDuplicate } from '../ssh/native';
import { getKeyMaterial, listKeys } from '../state/keys';
import { buildSavedConnectReq, connectTimeoutMs } from './savedConnect';
import { invoke } from '../bridge';
import { useConfirm } from '../ui/ConfirmModal';
import { useTextPrompt } from '../ui/PromptModal';
import { ResizeHandle, usePanelWidth } from '../ui/ResizeHandle';
import { HeaderPaneToggle } from '../ui/WorkbenchSurface';
import { ConnectForm } from './ConnectForm';
import { reconcilePanes } from './panes';
import { ptyOpen } from './pty';
import { SessionView } from './SessionView';
import { useTerminals, type TermTab } from './store';

const NAV_FOLD_KEY = 'termipod.term.navFold';
const GROUP_FOLD_KEY = 'termipod.term.groupFold';

// A right-click target in the connections nav: a whole group, one connection, or
// blank space in the list (below/around the rows).
type NavMenu = {
  x: number;
  y: number;
  target: { kind: 'group'; name: string } | { kind: 'conn'; id: string } | { kind: 'blank' };
};

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Persisted dock height/width (#319). Clamped loosely; the drag handler applies
// the live viewport-relative bounds.
function loadDockSize(key: string, fallback: number): number {
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) && v >= 140 ? v : fallback;
}
function saveDockSize(key: string, n: number): void {
  try {
    localStorage.setItem(key, String(n));
  } catch {
    /* ignore */
  }
}

/// The persistent terminal panel (professional-terminal, → ADR-053). Mounted once
/// inside the workbench main for the app's lifetime — never unmounted, because
/// unmounting a `<Screen>` closes its PTY/SSH session. It renders in one of two
/// modes, switched purely by CSS so no `<Screen>` is ever re-parented:
///
///   • **surface** (the `terminal` job is active) — a full job surface: a left
///     nav listing saved SSH connections (resizable + foldable) and a main column
///     whose head is a tab strip of the open sessions over a split-able pane area.
///   • **dock** (any other job) — the compact bottom strip of old, shown only
///     when toggled (Ctrl+`); absolutely positioned so it overlays the active
///     surface without disturbing it.
///
/// Sessions and connections are deliberately *different categories* (director
/// feedback): live sessions are the tabs in the head; saved connections are the
/// left nav. The store (`useTerminals`) owns the sessions; this panel is a view.
export function TerminalPanel(): JSX.Element {
  const t = useT();
  const job = useWorkbench((s) => s.job);
  const open = useTerminals((s) => s.open);
  const tabs = useTerminals((s) => s.tabs);
  const activeId = useTerminals((s) => s.activeId);
  const addTab = useTerminals((s) => s.addTab);
  const closeTab = useTerminals((s) => s.closeTab);
  const replaceSession = useTerminals((s) => s.replaceSession);
  const setActive = useTerminals((s) => s.setActive);
  const setOpen = useTerminals((s) => s.setOpen);
  const dockSide = useTerminals((s) => s.dockSide);
  const setDockSide = useTerminals((s) => s.setDockSide);

  const tauri = isShell();
  const [connecting, setConnecting] = useState(false);
  const [initialConnId, setInitialConnId] = useState<string | null>(null);
  /** The tab a pending connect attempt should REBIND rather than sit beside —
   *  set by the Reconnect button, cleared by any other way of opening the form. */
  const [reconnectFor, setReconnectFor] = useState<string | null>(null);
  /** The tab whose SILENT reconnect (straight from the saved connection, no
   *  form) is in flight — its dead banner shows the attempt meanwhile. */
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);
  /** Saved connection being opened directly from its nav context menu. */
  const [quickConnectingId, setQuickConnectingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // This panel stays mounted for the app's lifetime; failures must not.
  useEffect(() => {
    if (error === null) return;
    const timer = setTimeout(() => setError(null), 15_000);
    return () => clearTimeout(timer);
  }, [error]);
  const [notice, setNotice] = useState<string | null>(null);
  const cfgRef = useRef<HTMLInputElement>(null);
  // Dock size persists across launches (#319) like the nav width + dock side do.
  // Keep the live value in a ref: resizing by mutating the one wrapper avoids
  // re-rendering every terminal/session card on every pointer event.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const sizeRef = useRef({
    h: loadDockSize('termipod.term.dockH', 340),
    w: loadDockSize('termipod.term.dockW', 480),
  });
  // Drag state for the dock resize edge — `axis` follows the dock side (top edge
  // for the bottom dock, left edge for the right dock). The rendered axis also
  // mounts a window-wide hit shield so an Electron <webview> guest cannot steal
  // the gesture when the cursor crosses onto the tunneled page.
  const dragRef = useRef<{ axis: 'y' | 'x'; start: number; startSize: number } | null>(null);
  const dragPointRef = useRef<{ x: number; y: number } | null>(null);
  const dragFrameRef = useRef(0);
  const [dragAxis, setDragAxis] = useState<'x' | 'y' | null>(null);

  // Surface-mode split layout (local — the panel never unmounts, so it persists
  // across job switches like the sessions do). `panes` is the set of session ids
  // tiled in the split; `orientation` is row (side-by-side) or column (stacked).
  const [panes, setPanes] = useState<string[]>([]);
  const [orientation, setOrientation] = useState<'row' | 'column'>('row');
  const [conns, setConns] = useState<Connection[]>(() => (tauri ? listConnections() : []));

  // Left-nav width (persisted, clamped) + fold state.
  const [navW, onNavResize] = usePanelWidth('termipod.term.navW', 210, 150, 420);
  const [navFold, setNavFold] = useState(() => localStorage.getItem(NAV_FOLD_KEY) === '1');

  // Group folding (keyed lowercase, matching the case-insensitive group identity)
  // + a bump to recompute the derived group list after a group-only mutation (a
  // new/renamed/deleted group that doesn't change `conns` on its own).
  const [foldedGroups, setFoldedGroups] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(GROUP_FOLD_KEY) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const [groupBump, setGroupBump] = useState(0);
  const [navMenu, setNavMenu] = useState<NavMenu | null>(null);
  const { ask, node: promptNode } = useTextPrompt();
  const { ask: confirmAsk, node: confirmNode } = useConfirm();
  const groups = useMemo(() => (tauri ? navGroups(conns) : []), [conns, groupBump, tauri]);

  function refreshConns(): void {
    setConns(tauri ? listConnections() : []);
    setGroupBump((v) => v + 1);
  }
  function toggleGroupFold(name: string): void {
    setFoldedGroups((prev) => {
      const next = new Set(prev);
      const key = name.toLowerCase();
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(GROUP_FOLD_KEY, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  }
  function toggleFold(): void {
    setNavFold((v) => {
      const n = !v;
      try {
        localStorage.setItem(NAV_FOLD_KEY, n ? '1' : '0');
      } catch {
        /* ignore */
      }
      return n;
    });
  }

  // "+" new-session menu (local shell / SSH).
  const [addMenu, setAddMenu] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);

  const mode: 'surface' | 'dock' = job === 'terminal' ? 'surface' : 'dock';

  // Refresh the saved-connections nav when the connect form closes (a new one may
  // have been added there).
  useEffect(() => {
    if (!connecting && tauri) setConns(listConnections());
  }, [connecting, tauri]);

  // A vault sync-down / recovery-restore rewrites the saved connections straight
  // to localStorage (see vault/bundle.ts importBundle). This panel is
  // always-mounted (it owns live PTY/SSH sessions), so without this it would keep
  // showing the pre-sync list until an app restart. Re-read on the broadcast.
  useEffect(() => {
    if (!tauri) return;
    const onImported = (): void => refreshConns();
    window.addEventListener('termipod:vault-imported', onImported);
    return () => window.removeEventListener('termipod:vault-imported', onImported);
    // refreshConns is stable (defined in render, closes over stable setters).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tauri]);

  // Dismiss the "+" menu on an outside click.
  useEffect(() => {
    function onDoc(e: MouseEvent): void {
      if (addRef.current !== null && !addRef.current.contains(e.target as Node)) setAddMenu(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // Dismiss the nav context menu on any outside click, scroll, or Escape.
  useEffect(() => {
    if (navMenu === null) return;
    const close = (): void => setNavMenu(null);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setNavMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [navMenu]);

  // Nav context-menu actions. All refresh the local `conns` mirror afterwards.
  // `ask` is the in-app text prompt (window.prompt renders an unreliable native
  // `tauri.localhost` dialog in the webview — see useTextPrompt).
  async function promptNewGroup(assignId?: string): Promise<void> {
    setNavMenu(null);
    const name = await ask(t('term.newGroupPrompt'));
    if (name === null || name.trim() === '') return;
    addGroup(name.trim());
    if (assignId !== undefined) setConnectionGroup(assignId, name.trim());
    refreshConns();
  }
  async function promptRenameGroup(from: string): Promise<void> {
    setNavMenu(null);
    const to = await ask(t('term.renameGroupPrompt'), from);
    if (to === null || to.trim() === '' || to.trim() === from) return;
    renameGroup(from, to.trim());
    refreshConns();
  }
  async function doDeleteGroup(name: string): Promise<void> {
    setNavMenu(null);
    if (!(await confirmAsk({ message: t('term.confirmDeleteGroup').replace('{name}', name), danger: true })))
      return;
    removeGroup(name);
    refreshConns();
  }
  function doMoveToGroup(id: string, group: string): void {
    setNavMenu(null);
    setConnectionGroup(id, group);
    refreshConns();
  }
  async function doDeleteConnection(id: string): Promise<void> {
    setNavMenu(null);
    const name = conns.find((c) => c.id === id)?.name ?? '';
    if (!(await confirmAsk({ message: t('term.confirmDeleteConn').replace('{name}', name), danger: true })))
      return;
    try {
      await deleteConnection(id);
    } finally {
      refreshConns();
    }
  }

  // Seed / prune / adopt the split against the live session list — see
  // reconcilePanes for the three rules. In surface mode this set, not activeId,
  // is what renders, so a session missing from it is invisible however active it
  // is.
  useEffect(() => {
    setPanes((prev) => reconcilePanes(prev, tabs.map((tb) => tb.id), activeId));
  }, [tabs, activeId]);

  const paneShown = (id: string): boolean =>
    mode === 'surface' ? panes.includes(id) : !connecting && id === activeId;

  async function newLocal(): Promise<string | null> {
    setError(null);
    setAddMenu(false);
    try {
      const { id, shell } = await ptyOpen({ cols: 80, rows: 24 });
      const uiId = addTab({ kind: 'local', sessionId: id, shell, title: t('term.localShell') });
      setConnecting(false);
      return uiId;
    } catch (e) {
      setError(msg(e));
      return null;
    }
  }

  // `reconnectTabId` marks this attempt as a rebind of an existing tab. Every
  // other caller passes nothing and so CLEARS a pending rebind — opening a
  // different host from the nav while a reconnect form is up must not silently
  // hijack the dead tab.
  function openConnect(connId?: string, reconnectTabId?: string, failure: string | null = null): void {
    setError(failure);
    setInitialConnId(connId ?? null);
    setReconnectFor(reconnectTabId ?? null);
    setConnecting(true);
    setAddMenu(false);
  }

  // Context-menu Connect is a real one-click action, distinct from Edit. Replay
  // the saved vault/key credentials directly; only fall back to the prefilled
  // form when the connection cannot be replayed or needs user intervention.
  async function connectSavedConnection(id: string): Promise<void> {
    setNavMenu(null);
    if (quickConnectingId !== null) return;
    const conn = listConnections().find((candidate) => candidate.id === id);
    if (conn === undefined) {
      refreshConns();
      return;
    }

    setQuickConnectingId(id);
    setError(null);
    const attempt = { cancelled: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const req = await buildSavedConnectReq(conn, `q${Date.now()}`, {
        getPassword: getConnectionPassword,
        getJumpPassword: getConnectionJumpPassword,
        getKey: getKeyMaterial,
      });
      if (attempt.cancelled) return;
      if (req === null) {
        openConnect(id);
        return;
      }
      // Credential lookup may wait for an OS-keychain prompt; only the SSH
      // handshake is subject to the network timeout.
      timer = setTimeout(() => {
        attempt.cancelled = true;
        setQuickConnectingId(null);
        openConnect(id, undefined, t('term.connectTimeout'));
      }, connectTimeoutMs(conn));
      const sessionId = await sshConnect(req);
      if (attempt.cancelled) {
        void sshClose(sessionId);
        return;
      }
      touchConnection(conn.id);
      addTab({ kind: 'ssh', sessionId, title: `${conn.username}@${conn.host}`, connId: conn.id });
      setError(null);
      setConnecting(false);
    } catch (e) {
      if (!attempt.cancelled) openConnect(id, undefined, msg(e));
    } finally {
      clearTimeout(timer);
      if (!attempt.cancelled) setQuickConnectingId(null);
    }
  }

  // Import an OpenSSH client config (~/.ssh/config) into saved connections. Read
  // in the web layer via the File API (no fs plugin); re-import updates in place.
  async function onImportConfig(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (file === undefined) return;
    setError(null);
    try {
      const res = await importSshConfig(await file.text(), listConnections());
      setConns(listConnections());
      const base = t.plural('term.importedConfig', res.count);
      setNotice(
        res.keysAdded > 0 ? `${base} · ${t.plural('term.importedKeys', res.keysAdded)}` : base,
      );
      setTimeout(() => setNotice(null), 4000);
    } catch (ex) {
      setError(msg(ex));
    }
  }

  // Export saved connections as an OpenSSH client config via the native save
  // dialog. Secrets stay in the vault (see exportSshConfig); key-auth hosts get
  // a comment naming their vault key, resolved here from the key store.
  async function onExportConfig(): Promise<void> {
    setError(null);
    const all = listConnections();
    if (all.length === 0) {
      setNotice(t('term.exportConfigEmpty'));
      setTimeout(() => setNotice(null), 4000);
      return;
    }
    try {
      const keyNames = Object.fromEntries(listKeys().map((k) => [k.id, k.name]));
      const path = await invoke<string | null>('doc_save', {
        content: exportSshConfig(all, keyNames),
        defaultName: 'ssh_config',
      });
      if (path !== null) {
        setNotice(t('term.exportedConfig'));
        setTimeout(() => setNotice(null), 4000);
      }
    } catch (ex) {
      setError(msg(ex));
    }
  }

  function onConnected(sessionId: string, title: string, connId?: string): void {
    setError(null);
    // A reconnect rebinds the tab that asked for it instead of opening a second
    // one: same UI id, same pane slot, same scrollback position on screen — and
    // <Screen> keys on sessionId, so it re-streams and clears its dead banner by
    // itself. Adding a fresh tab here was the reconnect bug: the dead tab stayed
    // tiled, the new session landed on a tab nothing was showing, and a
    // successful reconnect looked like a no-op.
    if (reconnectFor !== null && tabs.some((tb) => tb.id === reconnectFor)) {
      replaceSession(reconnectFor, sessionId, { title, connId });
      setActive(reconnectFor);
    } else {
      addTab({ kind: 'ssh', sessionId, title, connId });
    }
    setReconnectFor(null);
    setConnecting(false);
  }

  // Reconnect a dead session (#319). A local shell rebinds in place (a fresh PTY
  // into the same tab). An SSH tab with a saved connection reconnects IN PLACE
  // too: every credential the connect form would send is already stored (the
  // vault password slot, the key store), so the attempt is made silently and
  // the form opens only when it cannot be — a missing credential, a failed
  // handshake — because the form is where the user can fix either. Opening the
  // form first and waiting for a Connect click made every reconnect a
  // two-step detour through the connection's detail page.
  async function reconnect(tab: TermTab): Promise<void> {
    setError(null);
    if (tab.kind === 'local') {
      try {
        const { id, shell } = await ptyOpen({ cols: 80, rows: 24 });
        replaceSession(tab.id, id, { shell });
      } catch (e) {
        setError(msg(e));
      }
      return;
    }
    // setActive, not focusSession: the dead tab is already tiled, and
    // focusSession would collapse a split down to it just because one half
    // needed reconnecting.
    setActive(tab.id);
    if (reconnectingId !== null) return; // one silent attempt at a time
    const conn = tab.connId !== undefined ? listConnections().find((c) => c.id === tab.connId) : undefined;
    const req =
      conn !== undefined
        ? await buildSavedConnectReq(conn, `r${Date.now()}`, {
            getPassword: getConnectionPassword,
            getJumpPassword: getConnectionJumpPassword,
            getKey: getKeyMaterial,
          })
        : null;
    if (conn === undefined || req === null) {
      // Ad-hoc tab, deleted connection, or a credential that was never stored
      // (pasted key, empty vault slot) — the form is the only way forward.
      openConnect(tab.connId, tab.id);
      return;
    }
    setReconnectingId(tab.id);
    setError(null);
    // The same abandon rule as the form (#319): past the ceiling the attempt is
    // written off, and if the core connects anyway the orphaned session is
    // closed rather than leaking a remote shell nobody renders.
    const attempt = { cancelled: false };
    const timer = setTimeout(() => {
      attempt.cancelled = true;
      setReconnectingId(null);
      setActive(tab.id);
      openConnect(tab.connId, tab.id);
    }, connectTimeoutMs(conn));
    try {
      const sid = await sshConnect(req);
      // Abandoned (timeout) or the dead tab was closed mid-attempt — either
      // way replaceSession has nothing to rebind, and an unrendered session
      // would leak a remote shell. Close it instead.
      if (attempt.cancelled || !useTerminals.getState().tabs.some((tb) => tb.id === tab.id)) {
        void sshClose(sid);
        return;
      }
      touchConnection(conn.id);
      replaceSession(tab.id, sid, { title: `${conn.username}@${conn.host}`, connId: conn.id });
    } catch (e) {
      if (!attempt.cancelled) {
        // Fall back to the form with the row preselected; the failure reason
        // lands beside the terminal so the fallback does not read as a whim.
        openConnect(tab.connId, tab.id, msg(e));
      }
    } finally {
      clearTimeout(timer);
      if (!attempt.cancelled) setReconnectingId(null);
    }
  }

  // Split the current view (#319): an SSH tab duplicates onto a FRESH channel
  // of the same backend connection (no re-auth — ssh.rs `ssh_duplicate`);
  // anything else spawns a new local shell. The whole group shares one
  // orientation in this round; a nested split tree is a follow-up.
  async function split(o: 'row' | 'column'): Promise<void> {
    setOrientation(o);
    const active = tabs.find((tb) => tb.id === activeId);
    const uiId = active?.kind === 'ssh' ? await duplicateSsh(active) : await newLocal();
    if (uiId !== null) setPanes((p) => (p.includes(uiId) ? p : [...p, uiId]));
  }

  // Split-duplicate an SSH tab: a second interactive shell on the SAME
  // connection, tiled beside the original and titled after it.
  async function duplicateSsh(tab: TermTab): Promise<string | null> {
    setError(null);
    try {
      const sessionId = await sshDuplicate(tab.sessionId, 80, 24);
      const uiId = addTab({ kind: 'ssh', sessionId, title: tab.title, connId: tab.connId });
      setConnecting(false);
      return uiId;
    } catch (e) {
      setError(msg(e));
      return null;
    }
  }

  // Show a session as the sole tile (tab click) — or just focus it if it's
  // already tiled.
  function focusSession(id: string): void {
    setActive(id);
    setConnecting(false);
    if (mode === 'surface') setPanes((p) => (p.includes(id) ? p : [id]));
  }

  function closePaneAt(id: string): void {
    setPanes((p) => p.filter((x) => x !== id));
  }

  async function close(id: string): Promise<void> {
    // A live SSH session ends a remote shell (and any running process) when its
    // tab closes — confirm first. Local shells are cheap to respawn, so they
    // close immediately.
    const tab = tabs.find((tb) => tb.id === id);
    if (tab?.kind === 'ssh' && !(await confirmAsk({ message: t('term.confirmCloseSession'), danger: true })))
      return;
    setPanes((p) => p.filter((x) => x !== id));
    closeTab(id);
  }

  // Drag the dock's inner edge to resize it (dock mode only; clamped). Direct
  // wrapper style writes are coalesced to one per animation frame; committing
  // through React on every raw mousemove made xterm re-render its full subtree
  // faster than the browser could paint. The fixed shield rendered below keeps
  // events in the shell even while the pointer is over an Electron <webview>.
  useEffect(() => {
    function applyMove(): void {
      const d = dragRef.current;
      const point = dragPointRef.current;
      const el = wrapRef.current;
      if (d === null || point === null || el === null) return;
      if (d.axis === 'y') {
        const next = Math.max(140, Math.min(d.startSize + (d.start - point.y), window.innerHeight - 160));
        sizeRef.current.h = next;
        el.style.height = `${next}px`;
      } else {
        const next = Math.max(260, Math.min(d.startSize + (d.start - point.x), window.innerWidth - 200));
        sizeRef.current.w = next;
        el.style.width = `${next}px`;
      }
    }
    function onMove(e: PointerEvent): void {
      if (dragRef.current === null) return;
      dragPointRef.current = { x: e.clientX, y: e.clientY };
      if (dragFrameRef.current !== 0) return;
      dragFrameRef.current = requestAnimationFrame(() => {
        dragFrameRef.current = 0;
        applyMove();
      });
    }
    function finish(): void {
      if (dragRef.current === null) return;
      if (dragFrameRef.current !== 0) {
        cancelAnimationFrame(dragFrameRef.current);
        dragFrameRef.current = 0;
        applyMove();
      }
      dragRef.current = null;
      dragPointRef.current = null;
      saveDockSize('termipod.term.dockH', sizeRef.current.h);
      saveDockSize('termipod.term.dockW', sizeRef.current.w);
      setDragAxis(null);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
      if (dragFrameRef.current !== 0) cancelAnimationFrame(dragFrameRef.current);
    };
  }, []);

  const visible = mode === 'surface' || open;
  const panelClass = `term-panel ${mode}${mode === 'dock' ? ` ${dockSide}` : ''}${
    mode === 'surface' && navFold ? ' nav-folded' : ''
  }${visible ? '' : ' hidden'}`;
  const style =
    mode === 'dock'
      ? dockSide === 'right'
        ? { width: sizeRef.current.w }
        : { height: sizeRef.current.h }
      : undefined;
  const navStyle = mode === 'surface' && !navFold ? { width: navW } : undefined;

  const addMenuEl = (
    <div className="term-add" ref={addRef}>
      <button
        className="term-add-btn"
        title={t('term.newSession')}
        disabled={!tauri}
        onClick={() => setAddMenu((v) => !v)}
      >
        <Icon name="plus" size={14} />
      </button>
      {addMenu && (
        <div className="term-add-menu">
          <button onClick={() => void newLocal()}>{t('term.localShell')}</button>
          <button onClick={() => openConnect()}>{t('term.ssh')}</button>
        </div>
      )}
    </div>
  );

  const sessionTabsEl = (
    <div className="term-tabs">
      {tabs.length === 0 && <span className="muted small term-tabs-empty">{t('term.navNoSessions')}</span>}
      {tabs.map((tab) => (
        <div key={tab.id} className={!connecting && tab.id === activeId ? 'term-tab active' : 'term-tab'}>
          <button className="term-tab-pick" title={tab.title} onClick={() => focusSession(tab.id)}>
            <span className={`term-tab-kind ${tab.kind}`} />
            {tab.title}
            {tab.unread === true && tab.id !== activeId && (
              <span className="term-tab-unread" title={t('term.unread')} aria-label={t('term.unread')} />
            )}
          </button>
          <button className="term-tab-x" title={t('term.closeTab')} onClick={() => void close(tab.id)}>
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
    </div>
  );

  const splitControlsEl = tauri && (
    <span className="term-split-ctl">
      <button
        className={orientation === 'row' ? 'active' : ''}
        title={t('term.splitRight')}
        onClick={() => void split('row')}
        disabled={activeId === null}
      >
        <Icon name="split-h" size={14} />
      </button>
      <button
        className={orientation === 'column' ? 'active' : ''}
        title={t('term.splitDown')}
        onClick={() => void split('column')}
        disabled={activeId === null}
      >
        <Icon name="split-v" size={14} />
      </button>
    </span>
  );

  return (
    <div ref={wrapRef} className={panelClass} style={style}>
      {/* Connection-file management lives in the nav context menu. Keep its
          picker mounted here instead of consuming session-header space. */}
      <input ref={cfgRef} type="file" hidden onChange={(e) => void onImportConfig(e)} />

      {mode === 'dock' && (
        <div
          className="term-dock-resize"
          onPointerDown={(e) => {
            e.preventDefault();
            dragPointRef.current = { x: e.clientX, y: e.clientY };
            const drag =
              dockSide === 'right'
                ? ({ axis: 'x', start: e.clientX, startSize: sizeRef.current.w } as const)
                : ({ axis: 'y', start: e.clientY, startSize: sizeRef.current.h } as const);
            dragRef.current = drag;
            setDragAxis(drag.axis);
          }}
        />
      )}

      {mode === 'surface' && (
        <div className="term-surface-head">
          <div className="term-surface-identity" style={!navFold ? { width: navW } : undefined}>
            <HeaderPaneToggle
              side="left"
              open={!navFold}
              showLabel={t('nav.expand')}
              hideLabel={t('term.foldNav')}
              onToggle={toggleFold}
            />
            <span className="term-head-title">{t('term.navConnections')}</span>
          </div>
          <span className="term-surface-divider" aria-hidden="true" />
          <div className="term-surface-actions">
            {sessionTabsEl}
            {addMenuEl}
            <span className="spacer" />
            {splitControlsEl}
          </div>
        </div>
      )}

      {/* Left nav — saved connections/hosts (surface mode; CSS-hidden in dock).
          Always rendered so the pane area keeps a stable DOM position and its
          <Screen>s are never re-parented. */}
      <aside className={`term-nav${navFold ? ' folded' : ''}`} style={navStyle}>
        {notice !== null && <div className="muted small term-nav-notice">{notice}</div>}
        <div
          className="term-nav-list"
          onContextMenu={(e) => {
            // A row / group-header right-click sets its own menu first (bubbles up
            // to here); guard so blank space is the only thing that opens the
            // blank menu — never overwrite a more specific target.
            if ((e.target as HTMLElement).closest('.term-nav-item, .term-nav-group-head') !== null) return;
            e.preventDefault();
            setNavMenu({ x: e.clientX, y: e.clientY, target: { kind: 'blank' } });
          }}
        >
          {conns.length === 0 && groups.length <= 1 && (
            <div className="muted small term-nav-empty">{t('term.noSaved')}</div>
          )}
          {/* With only the default group, list connections flat (no header noise).
              Once a second group exists, show every group as a foldable section. */}
          {groups.length <= 1
            ? conns.map((c) => (
                <ConnRow
                  key={c.id}
                  c={c}
                  active={(connecting && initialConnId === c.id) || quickConnectingId === c.id}
                  connecting={quickConnectingId === c.id}
                  connectDisabled={quickConnectingId !== null}
                  onOpen={() => openConnect(c.id)}
                  onConnect={() => void connectSavedConnection(c.id)}
                  onMenu={(e) => {
                    e.preventDefault();
                    setNavMenu({ x: e.clientX, y: e.clientY, target: { kind: 'conn', id: c.id } });
                  }}
                />
              ))
            : groups.map((g) => {
                const gl = g.toLowerCase();
                const gconns = conns.filter((c) => connectionGroup(c).toLowerCase() === gl);
                const folded = foldedGroups.has(gl);
                return (
                  <div key={gl} className="term-nav-group">
                    <button
                      className="term-nav-group-head"
                      onClick={() => toggleGroupFold(g)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setNavMenu({ x: e.clientX, y: e.clientY, target: { kind: 'group', name: g } });
                      }}
                    >
                      <Icon name={folded ? 'chevron-right' : 'chevron-down'} size={12} />
                      <span className="term-nav-group-name">{g}</span>
                      <span className="spacer" />
                      <span className="muted small">{gconns.length}</span>
                    </button>
                    {!folded &&
                      gconns.map((c) => (
                        <ConnRow
                          key={c.id}
                          grouped
                          c={c}
                          active={(connecting && initialConnId === c.id) || quickConnectingId === c.id}
                          connecting={quickConnectingId === c.id}
                          connectDisabled={quickConnectingId !== null}
                          onOpen={() => openConnect(c.id)}
                          onConnect={() => void connectSavedConnection(c.id)}
                          onMenu={(e) => {
                            e.preventDefault();
                            setNavMenu({ x: e.clientX, y: e.clientY, target: { kind: 'conn', id: c.id } });
                          }}
                        />
                      ))}
                  </div>
                );
              })}
        </div>
      </aside>
      {mode === 'surface' && !navFold && <ResizeHandle onResize={onNavResize} />}

      <div className="term-main">
        {mode === 'dock' && (
          <div className="term-head">
            {sessionTabsEl}
            {addMenuEl}
            <span className="spacer" />
            <button
              className="term-dock-side"
              title={dockSide === 'right' ? t('term.dockBottom') : t('term.dockRight')}
              onClick={() => setDockSide(dockSide === 'right' ? 'bottom' : 'right')}
            >
              <Icon name={dockSide === 'right' ? 'dock-bottom' : 'dock-right'} size={14} />
            </button>
            <button className="term-dock-hide" title={t('term.hideDock')} onClick={() => setOpen(false)}>
              <Icon name={dockSide === 'right' ? 'chevron-right' : 'chevron-down'} size={15} />
            </button>
          </div>
        )}

        {(quickConnectingId !== null || reconnectingId !== null) && (
          <div className="term-connection-status" role="status" aria-live="polite">
            <span className="term-connecting-spinner" aria-hidden="true"><Icon name="refresh" size={16} /></span>
            <span>
              {t('term.connecting')}{' · '}
              {quickConnectingId !== null
                ? conns.find((c) => c.id === quickConnectingId)?.name
                : tabs.find((tab) => tab.id === reconnectingId)?.title}
            </span>
          </div>
        )}
        {error !== null && (
          <div className="term-connection-status error" role="alert">
            <span>{error}</span>
            <button className="icon-btn" title={t('common.close')} aria-label={t('common.close')} onClick={() => setError(null)}>
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
        <div className={`term-panes ${orientation}`}>
          {!tauri ? (
            <div className="term-banner">{t('term.desktopOnly')}</div>
          ) : (
            <>
              {tabs.map((tab) => {
                const shown = paneShown(tab.id);
                return (
                  <div
                    key={tab.id}
                    className={`term-pane${shown ? '' : ' hidden'}${
                      shown && mode === 'surface' && tab.id === activeId && panes.length > 1 ? ' focused' : ''
                    }`}
                    onMouseDown={() => mode === 'surface' && setActive(tab.id)}
                  >
                    {mode === 'surface' && panes.length > 1 && (
                      <div className="term-pane-head">
                        <span className={`term-tab-kind ${tab.kind}`} />
                        <span className="term-pane-title">{tab.title}</span>
                        <span className="spacer" />
                        <button
                          className="term-pane-x"
                          title={t('term.closePane')}
                          onClick={() => closePaneAt(tab.id)}
                        >
                          <Icon name="close" size={12} />
                        </button>
                      </div>
                    )}
                    <div className="term-pane-body">
                      <SessionView
                        tab={tab}
                        onReconnect={() => void reconnect(tab)}
                        reconnecting={reconnectingId === tab.id}
                      />
                    </div>
                  </div>
                );
              })}

              {connecting && (
                <div className="term-pane term-pane-overlay">
                  {/* Keyed on the picked connection so selecting a different host
                      in the nav remounts the form with that host prefilled (a bare
                      prop change wouldn't re-run the mount-time prefill). */}
                  <ConnectForm
                    key={initialConnId ?? '__new__'}
                    initialConnId={initialConnId ?? undefined}
                    onConnected={onConnected}
                    onConnectStart={() => setError(null)}
                    onSaved={refreshConns}
                    onCancel={() => {
                      setError(null);
                      setReconnectFor(null);
                      setConnecting(false);
                    }}
                  />
                </div>
              )}

              {!connecting && tabs.length === 0 && (
                <div className="term-empty">
                  <p className="muted">{t('term.emptyHint')}</p>
                  <div className="term-empty-actions">
                    <button className="primary" onClick={() => void newLocal()}>
                      + {t('term.localShell')}
                    </button>
                    <button onClick={() => openConnect()}>+ {t('term.ssh')}</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {navMenu !== null && (
        <NavContextMenu
          menu={navMenu}
          groups={groups}
          conns={conns}
          onNewConnection={() => {
            setNavMenu(null);
            openConnect();
          }}
          onImportConfig={() => {
            setNavMenu(null);
            cfgRef.current?.click();
          }}
          onExportConfig={() => {
            setNavMenu(null);
            void onExportConfig();
          }}
          onNewGroup={promptNewGroup}
          onRenameGroup={promptRenameGroup}
          onDeleteGroup={doDeleteGroup}
          onMoveToGroup={doMoveToGroup}
          onConnectConn={(id) => void connectSavedConnection(id)}
          onEditConn={(id) => {
            setNavMenu(null);
            openConnect(id);
          }}
          onDeleteConn={(id) => void doDeleteConnection(id)}
        />
      )}
      {promptNode}
      {confirmNode}
      {dragAxis !== null &&
        createPortal(
          <div className={`term-dock-resize-shield ${dragAxis}`} aria-hidden="true" />,
          document.body,
        )}
    </div>
  );
}

// One connection row in the nav. Extracted so the flat and grouped renderings
// share it; `grouped` indents it under a group header.
function ConnRow({
  c,
  active,
  connecting,
  connectDisabled,
  grouped,
  onOpen,
  onConnect,
  onMenu,
}: {
  c: Connection;
  active: boolean;
  connecting: boolean;
  connectDisabled: boolean;
  grouped?: boolean;
  onOpen: () => void;
  onConnect: () => void;
  onMenu: (e: ReactMouseEvent) => void;
}): JSX.Element {
  const t = useT();
  const connectLabel = connecting ? t('term.connecting') : t('term.connect');
  return (
    <div
      className={`term-nav-item term-nav-conn${active ? ' active' : ''}${grouped ? ' grouped' : ''}`}
      title={`${c.username}@${c.host}:${c.port}`}
      onContextMenu={onMenu}
    >
      <button className="term-nav-pick" onClick={onOpen}>
        <span className="term-tab-kind ssh" />
        <span className="term-nav-conn-name">{c.name}</span>
      </button>
      <button
        className="term-nav-quick"
        title={`${connectLabel}: ${c.name}`}
        aria-label={`${connectLabel}: ${c.name}`}
        aria-busy={connecting}
        disabled={connectDisabled}
        onClick={(e) => {
          e.stopPropagation();
          onConnect();
        }}
      >
        {connecting
          ? <span className="term-connecting-spinner" aria-hidden="true"><Icon name="refresh" size={14} /></span>
          : <Icon name="terminal" size={14} />}
      </button>
    </div>
  );
}

// The nav right-click menu — blank space (new connection / new group /
// import / export), a group header menu (new / rename / delete), or a
// connection menu (connect / edit / move-to-group / new group / delete).
function NavContextMenu({
  menu,
  groups,
  conns,
  onNewConnection,
  onImportConfig,
  onExportConfig,
  onNewGroup,
  onRenameGroup,
  onDeleteGroup,
  onMoveToGroup,
  onConnectConn,
  onEditConn,
  onDeleteConn,
}: {
  menu: NavMenu;
  groups: string[];
  conns: Connection[];
  onNewConnection: () => void;
  onImportConfig: () => void;
  onExportConfig: () => void;
  onNewGroup: (assignId?: string) => void;
  onRenameGroup: (from: string) => void;
  onDeleteGroup: (name: string) => void;
  onMoveToGroup: (id: string, group: string) => void;
  onConnectConn: (id: string) => void;
  onEditConn: (id: string) => void;
  onDeleteConn: (id: string) => void;
}): JSX.Element {
  const t = useT();
  const { target } = menu;
  const conn = target.kind === 'conn' ? conns.find((c) => c.id === target.id) : undefined;
  const curGroup = conn !== undefined ? connectionGroup(conn) : DEFAULT_GROUP;
  return (
    <div
      className="term-nav-ctxmenu"
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => e.stopPropagation()}
    >
      {target.kind === 'blank' ? (
        <>
          <button className="read-ctx-item" onClick={onNewConnection}>
            <Icon name="plus" size={14} /> {t('term.newConnection')}
          </button>
          <button className="read-ctx-item" onClick={() => onNewGroup()}>
            <Icon name="folder" size={14} /> {t('term.newGroup')}
          </button>
          <div className="read-ctx-sep" />
          <button className="read-ctx-item" onClick={onImportConfig}>
            <Icon name="external" size={14} /> {t('term.importConfig')}
          </button>
          <button className="read-ctx-item" onClick={onExportConfig}>
            <Icon name="download" size={14} /> {t('term.exportConfig')}
          </button>
        </>
      ) : target.kind === 'group' ? (
        <>
          <button className="read-ctx-item" onClick={() => onNewGroup()}>
            <Icon name="plus" size={14} /> {t('term.newGroup')}
          </button>
          {target.name.toLowerCase() !== DEFAULT_GROUP && (
            <>
              <button className="read-ctx-item" onClick={() => onRenameGroup(target.name)}>
                <Icon name="pen" size={14} /> {t('term.renameGroup')}
              </button>
              <div className="read-ctx-sep" />
              <button className="read-ctx-item danger" onClick={() => onDeleteGroup(target.name)}>
                <Icon name="trash" size={14} /> {t('term.deleteGroup')}
              </button>
            </>
          )}
        </>
      ) : (
        <>
          <button className="read-ctx-item" onClick={() => onConnectConn(target.id)}>
            <Icon name="terminal" size={14} /> {t('term.connect')}
          </button>
          <div className="read-ctx-sep" />
          <button className="read-ctx-item" onClick={() => onEditConn(target.id)}>
            <Icon name="pen" size={14} /> {t('term.editConnection')}
          </button>
          <div className="read-ctx-sep" />
          <div className="term-nav-ctx-label">{t('term.moveToGroup')}</div>
          {groups.map((g) => (
            <button
              key={g}
              className="read-ctx-item"
              disabled={g.toLowerCase() === curGroup.toLowerCase()}
              onClick={() => onMoveToGroup(target.id, g)}
            >
              <Icon name={g.toLowerCase() === curGroup.toLowerCase() ? 'check' : 'folder'} size={14} /> {g}
            </button>
          ))}
          <button className="read-ctx-item" onClick={() => onNewGroup(target.id)}>
            <Icon name="plus" size={14} /> {t('term.newGroup')}
          </button>
          <div className="read-ctx-sep" />
          <button className="read-ctx-item danger" onClick={() => onDeleteConn(target.id)}>
            <Icon name="trash" size={14} /> {t('term.delete')}
          </button>
        </>
      )}
    </div>
  );
}
