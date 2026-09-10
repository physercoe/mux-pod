import { useEffect, useRef, useState } from 'react';
import type { UnlistenFn } from '../bridge';
import { useT } from '../i18n';
import {
  onSshConnectPhase,
  sshClose,
  sshConnect,
  type SshConnectPhase,
  type SshConnectReq,
} from '../ssh/native';
import {
  DEFAULT_GROUP,
  deleteConnection,
  getConnectionJumpPassword,
  getConnectionPassword,
  listConnections,
  navGroups,
  setConnectionJumpPassword,
  setConnectionPassword,
  touchConnection,
  upsertConnection,
  type Connection,
} from '../state/connections';
import { getKeyMaterial, listKeys, type SshKeyMeta } from '../state/keys';
import { Icon } from '../ui/Icon';
import { ConfirmButton } from '../ui/ConfirmButton';
import { useConfirm } from '../ui/ConfirmModal';
import { rememberConnection, type ConnectionDraft } from './connectionDraft';

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type Auth = 'password' | 'key';

/// Button labels for the handshake stages the core reports on
/// `ssh-connect-progress` (ssh.rs) — the connect button follows them while an
/// attempt is in flight so a slow handshake never looks frozen (#319).
const PHASE_KEY: Record<SshConnectPhase, string> = {
  tcp: 'term.phaseTcp',
  auth: 'term.phaseAuth',
  channel: 'term.phaseChannel',
};

/// Ceiling on one connect attempt (#319): a firewall that silently drops the
/// SYN (or a stuck auth handshake) would otherwise leave the form busy
/// forever. Past this the attempt is abandoned; if the core connects anyway,
/// its orphaned session is closed (see connect()).
const CONNECT_TIMEOUT_MS = 20_000;

/// Attempt ids for `ssh-connect-progress` subscription, minted per click.
let connectSeq = 0;

// Snapshot of the form fields, for the dirty-close guard (#313): cancelling
// with unsaved edits used to drop them silently.
interface FormSnapshot {
  name: string;
  group: string;
  note: string;
  host: string;
  port: string;
  user: string;
  auth: Auth;
  password: string;
  keyId: string;
  privateKey: string;
  passphrase: string;
  useJump: boolean;
  jumpHost: string;
  jumpPort: string;
  jumpUser: string;
  jumpAuth: Auth;
  jumpKeyId: string;
  jumpPassword: string;
  useProxy: boolean;
  proxyHost: string;
  proxyPort: string;
  proxyUser: string;
  proxyPassword: string;
}
const BLANK_FORM: FormSnapshot = {
  name: '',
  group: DEFAULT_GROUP,
  note: '',
  host: '',
  port: '22',
  user: '',
  auth: 'password',
  password: '',
  keyId: '',
  privateKey: '',
  passphrase: '',
  useJump: false,
  jumpHost: '',
  jumpPort: '22',
  jumpUser: '',
  jumpAuth: 'password',
  jumpKeyId: '',
  jumpPassword: '',
  useProxy: false,
  proxyHost: '',
  proxyPort: '1080',
  proxyUser: '',
  proxyPassword: '',
};

/// The SSH connect surface (saved connections + key store over a connect form).
/// Extracted from the old breakglass modal so the terminal dock can present it as
/// a tab; on a successful connect it hands the new session id back up to the dock,
/// which opens a live terminal tab for it (ADR-052 personal direct SSH).
export function ConnectForm({
  onConnected,
  onConnectStart,
  onCancel,
  onSaved,
  initialConnId,
}: {
  onConnected: (sessionId: string, title: string, connId?: string) => void;
  onConnectStart?: () => void;
  onCancel?: () => void;
  /** Fired after Save/Update lands a row. The terminal nav mirrors the saved
   *  list into local state and otherwise refreshes only when this form
   *  CLOSES — without this, a saved connection appeared only after Connect
   *  or Cancel, which read as the save not having happened. */
  onSaved?: () => void;
  /** Preselect this saved connection on mount (nav click in the terminal). */
  initialConnId?: string;
}): JSX.Element {
  const t = useT();
  const { ask: confirmAsk, node: confirmNode } = useConfirm();
  const [id, setId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [group, setGroup] = useState(DEFAULT_GROUP);
  const [note, setNote] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [user, setUser] = useState('');
  const [auth, setAuth] = useState<Auth>('password');
  const [password, setPassword] = useState('');
  const [keyId, setKeyId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  // Jump host (ProxyJump) + SOCKS5 proxy — parity with the mobile form.
  const [useJump, setUseJump] = useState(false);
  const [jumpHost, setJumpHost] = useState('');
  const [jumpPort, setJumpPort] = useState('22');
  const [jumpUser, setJumpUser] = useState('');
  const [jumpAuth, setJumpAuth] = useState<Auth>('password');
  const [jumpKeyId, setJumpKeyId] = useState('');
  const [jumpPassword, setJumpPassword] = useState('');
  const [useProxy, setUseProxy] = useState(false);
  const [proxyHost, setProxyHost] = useState('');
  const [proxyPort, setProxyPort] = useState('1080');
  const [proxyUser, setProxyUser] = useState('');
  const [proxyPassword, setProxyPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<SshConnectPhase | null>(null);
  // The in-flight attempt, flagged by Cancel/timeout — the invoke itself can't
  // be cancelled, so a flagged attempt's late resolution is torn down instead.
  const attemptRef = useRef<{ cancelled: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keys, setKeys] = useState<SshKeyMeta[]>([]);
  const [base, setBase] = useState<FormSnapshot>(BLANK_FORM);

  useEffect(() => {
    setKeys(listKeys());
    if (initialConnId !== undefined) {
      const c = listConnections().find((x) => x.id === initialConnId);
      if (c !== undefined) void applyConnection(c);
    }
    // Prefill runs once on mount (the form remounts per open — keyed on the
    // selected connection in the terminal nav).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resetForm(): void {
    setId(null);
    setName('');
    setGroup(DEFAULT_GROUP);
    setNote('');
    setHost('');
    setPort('22');
    setUser('');
    setAuth('password');
    setPassword('');
    setKeyId('');
    setPrivateKey('');
    setPassphrase('');
    setUseJump(false);
    setJumpHost('');
    setJumpPort('22');
    setJumpUser('');
    setJumpAuth('password');
    setJumpKeyId('');
    setJumpPassword('');
    setUseProxy(false);
    setProxyHost('');
    setProxyPort('1080');
    setProxyUser('');
    setProxyPassword('');
    setError(null);
    setBase(BLANK_FORM);
  }

  async function applyConnection(c: Connection): Promise<void> {
    const pw = c.authMethod === 'password' ? ((await getConnectionPassword(c.id)) ?? '') : '';
    const grp = (c.group ?? '').trim() || DEFAULT_GROUP;
    const jump = (c.jumpHost ?? '') !== '';
    const jAuth: Auth = c.jumpAuthMethod === 'key' ? 'key' : 'password';
    const jpw = jump && jAuth === 'password' ? ((await getConnectionJumpPassword(c.id)) ?? '') : '';
    const prox = (c.proxyHost ?? '') !== '';
    setId(c.id);
    setName(c.name);
    setGroup(grp);
    setNote(c.note ?? '');
    setHost(c.host);
    setPort(String(c.port));
    setUser(c.username);
    setAuth(c.authMethod);
    setKeyId(c.keyId ?? '');
    setPrivateKey('');
    setPassphrase('');
    setUseJump(jump);
    setJumpHost(c.jumpHost ?? '');
    setJumpPort(String(c.jumpPort ?? 22));
    setJumpUser(c.jumpUsername ?? '');
    setJumpAuth(jAuth);
    setJumpKeyId(c.jumpKeyId ?? '');
    setJumpPassword(jpw);
    setUseProxy(prox);
    setProxyHost(c.proxyHost ?? '');
    setProxyPort(String(c.proxyPort ?? 1080));
    setProxyUser(c.proxyUsername ?? '');
    setProxyPassword(c.proxyPassword ?? '');
    setError(null);
    setPassword(pw);
    setBase({
      name: c.name,
      group: grp,
      note: c.note ?? '',
      host: c.host,
      port: String(c.port),
      user: c.username,
      auth: c.authMethod,
      password: pw,
      keyId: c.keyId ?? '',
      privateKey: '',
      passphrase: '',
      useJump: jump,
      jumpHost: c.jumpHost ?? '',
      jumpPort: String(c.jumpPort ?? 22),
      jumpUser: c.jumpUsername ?? '',
      jumpAuth: jAuth,
      jumpKeyId: c.jumpKeyId ?? '',
      jumpPassword: jpw,
      useProxy: prox,
      proxyHost: c.proxyHost ?? '',
      proxyPort: String(c.proxyPort ?? 1080),
      proxyUser: c.proxyUsername ?? '',
      proxyPassword: c.proxyPassword ?? '',
    });
  }

  function currentSnapshot(): FormSnapshot {
    return {
      name,
      group,
      note,
      host,
      port,
      user,
      auth,
      password,
      keyId,
      privateKey,
      passphrase,
      useJump,
      jumpHost,
      jumpPort,
      jumpUser,
      jumpAuth,
      jumpKeyId,
      jumpPassword,
      useProxy,
      proxyHost,
      proxyPort,
      proxyUser,
      proxyPassword,
    };
  }

  async function persistCurrent(): Promise<Connection> {
    const snapshot = currentSnapshot();
    const conn = await rememberConnection(
      { id, ...snapshot } satisfies ConnectionDraft,
      {
        defaultGroup: DEFAULT_GROUP,
        upsert: upsertConnection,
        setPassword: setConnectionPassword,
        setJumpPassword: setConnectionJumpPassword,
      },
    );
    setId(conn.id);
    // What is on screen is now what is stored: re-baseline the dirty-close
    // guard (#313) so cancelling after Save or Connect no longer warns.
    setBase(snapshot);
    onSaved?.();
    return conn;
  }

  async function saveCurrent(): Promise<void> {
    setError(null);
    try {
      await persistCurrent();
    } catch (e) {
      setError(msg(e));
    }
  }

  // Delete the connection being edited, then close (the terminal nav — the single
  // source of truth for the saved list — refreshes when this form unmounts).
  async function removeCurrent(): Promise<void> {
    if (id === null) return;
    try {
      await deleteConnection(id);
      onCancel?.();
    } catch (e) {
      setError(msg(e));
    }
  }

  async function connect(): Promise<void> {
    onConnectStart?.();
    setBusy(true);
    setError(null);
    setPhase(null);
    const attempt = { cancelled: false };
    attemptRef.current = attempt;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: UnlistenFn | null = null;
    try {
      // Connect is also Save/Update. Persist before starting the network
      // attempt so a failed or cancelled handshake is still reusable and the
      // user never has to re-enter the form.
      const conn = await persistCurrent();
      if (attempt.cancelled) return;
      // Each extra hop (SOCKS5 handshake, jump-host auth + forward) adds its own
      // round-trips, so the single-hop ceiling would abort legitimate chains.
      const timeoutMs = CONNECT_TIMEOUT_MS + (useJump ? 15_000 : 0) + (useProxy ? 10_000 : 0);
      timer = setTimeout(() => {
        if (attempt.cancelled) return;
        attempt.cancelled = true;
        attemptRef.current = null;
        setBusy(false);
        setPhase(null);
        setError(t('term.connectTimeout'));
      }, timeoutMs);
      // Minted per attempt and echoed on the core's phase ticks, so a stale
      // attempt's ticks never update this attempt's display.
      const attemptId = `c${++connectSeq}`;
      // Attached before the invoke so no phase tick is missed.
      unlisten = await onSshConnectPhase(attemptId, setPhase);
      const base = {
        host: host.trim(),
        port: Number(port) || 22,
        user: user.trim(),
        cols: 80,
        rows: 24,
        connect_id: attemptId,
      };
      let req: SshConnectReq;
      if (auth === 'password') {
        req = { ...base, password };
      } else if (keyId !== '') {
        const { pem, passphrase: pass } = await getKeyMaterial(keyId);
        if (pem === null) throw new Error(t('term.keyMissing'));
        req = { ...base, private_key: pem, passphrase: pass ?? undefined };
      } else {
        req = { ...base, private_key: privateKey, passphrase };
      }
      if (useJump && jumpHost.trim() !== '') {
        req.jump_host = jumpHost.trim();
        req.jump_port = Number(jumpPort) || 22;
        if (jumpUser.trim() !== '') req.jump_user = jumpUser.trim();
        if (jumpAuth === 'key' && jumpKeyId !== '') {
          const { pem, passphrase: pass } = await getKeyMaterial(jumpKeyId);
          if (pem === null) throw new Error(t('term.keyMissing'));
          req.jump_private_key = pem;
          req.jump_passphrase = pass ?? undefined;
        } else {
          // Mobile parity: an empty jump password reuses the main password.
          const jpw = jumpPassword !== '' ? jumpPassword : password;
          if (jpw !== '') req.jump_password = jpw;
        }
      }
      if (useProxy && proxyHost.trim() !== '') {
        req.proxy_host = proxyHost.trim();
        req.proxy_port = Number(proxyPort) || 1080;
        if (proxyUser.trim() !== '') req.proxy_username = proxyUser.trim();
        if (proxyPassword !== '') req.proxy_password = proxyPassword;
      }
      const sid = await sshConnect(req);
      if (attempt.cancelled) {
        // Abandoned (Cancel/timeout) but the core connected anyway — close the
        // orphaned session rather than leak a remote shell nobody renders.
        void sshClose(sid);
        return;
      }
      touchConnection(conn.id);
      onConnected(sid, `${user.trim()}@${host.trim()}`, conn.id);
    } catch (e) {
      if (!attempt.cancelled) setError(msg(e));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      unlisten?.();
      // A newer attempt may already be running (this one timed out and the user
      // retried) — only reset the UI when this attempt is still the current one.
      if (attemptRef.current === attempt) {
        attemptRef.current = null;
        setBusy(false);
        setPhase(null);
      }
    }
  }

  /// Abandon the in-flight attempt (#319). The core-side handshake can't be
  /// cancelled mid-await, so this flags it: connect() tears down a late
  /// success instead of opening a tab for it.
  function cancelConnect(): void {
    const attempt = attemptRef.current;
    if (attempt === null) return;
    attempt.cancelled = true;
    attemptRef.current = null;
    setBusy(false);
    setPhase(null);
  }

  const canConnect =
    host.trim() !== '' &&
    user.trim() !== '' &&
    (auth === 'password' ? password !== '' : keyId !== '' || privateKey.trim() !== '') &&
    (!useJump ||
      (jumpHost.trim() !== '' &&
        (jumpAuth === 'key' ? jumpKeyId !== '' : jumpPassword !== '' || password !== ''))) &&
    (!useProxy || proxyHost.trim() !== '');

  // Dirty-close guard (#313): cancelling with unsaved edits used to drop them
  // silently — confirm before dropping them.
  const dirty =
    name !== base.name ||
    group !== base.group ||
    note !== base.note ||
    host !== base.host ||
    port !== base.port ||
    user !== base.user ||
    auth !== base.auth ||
    password !== base.password ||
    keyId !== base.keyId ||
    privateKey !== base.privateKey ||
    passphrase !== base.passphrase ||
    useJump !== base.useJump ||
    jumpHost !== base.jumpHost ||
    jumpPort !== base.jumpPort ||
    jumpUser !== base.jumpUser ||
    jumpAuth !== base.jumpAuth ||
    jumpKeyId !== base.jumpKeyId ||
    jumpPassword !== base.jumpPassword ||
    useProxy !== base.useProxy ||
    proxyHost !== base.proxyHost ||
    proxyPort !== base.proxyPort ||
    proxyUser !== base.proxyUser ||
    proxyPassword !== base.proxyPassword;
  async function attemptCancel(): Promise<void> {
    if (!dirty || (await confirmAsk({ message: t('confirm.discardChanges'), danger: true }))) onCancel?.();
  }

  return (
    <div className="term-body term-connect">
      <div className="term-form">
        <div className="term-form-head">
          <strong>{id !== null ? t('term.editConnection') : t('term.newConnection')}</strong>
          {id !== null && (
            <button onClick={resetForm}>{t('term.newConnection')}</button>
          )}
        </div>
        <label className="term-field-name">
          {t('term.name')}
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('term.namePlaceholder')} />
        </label>
        <label className="term-field-group">
          {t('term.group')}
          {/* Free-text with a datalist of existing groups: pick one or type a new
              name (it materialises on save). */}
          <input
            value={group}
            list="term-group-list"
            onChange={(e) => setGroup(e.target.value)}
            placeholder={DEFAULT_GROUP}
          />
          <datalist id="term-group-list">
            {navGroups().map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </label>
        <label className="wide term-field-note">
          {t('term.hostNote')}
          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('term.hostNotePlaceholder')}
          />
        </label>
        <label className="term-field-host">
          {t('term.host')}
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="host.example.com" />
        </label>
        <label className="term-field-port">
          {t('term.port')}
          <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
        </label>
        <label className="term-field-user">
          {t('term.user')}
          <input value={user} onChange={(e) => setUser(e.target.value)} />
        </label>
        <label className="term-field-auth">
          {t('term.auth')}
          <div className="seg">
            <button className={auth === 'password' ? 'seg-btn active' : 'seg-btn'} onClick={() => setAuth('password')}>
              {t('term.password')}
            </button>
            <button className={auth === 'key' ? 'seg-btn active' : 'seg-btn'} onClick={() => setAuth('key')}>
              {t('term.privateKey')}
            </button>
          </div>
        </label>
        {auth === 'password' ? (
          <label className="term-field-credential">
            {t('term.password')}
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        ) : (
          <>
            <label className="term-field-credential">
              {t('term.useKey')}
              <select value={keyId} onChange={(e) => setKeyId(e.target.value)}>
                <option value="">{t('term.pasteKey')}</option>
                {keys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name} ({k.type})
                  </option>
                ))}
              </select>
            </label>
            {keyId === '' && (
              <>
                <label className="wide">
                  {t('term.privateKey')}
                  <textarea
                    value={privateKey}
                    spellCheck={false}
                    placeholder={t('term.keyPlaceholder')}
                    onChange={(e) => setPrivateKey(e.target.value)}
                  />
                </label>
                <label className="term-field-credential">
                  {t('term.passphrase')}
                  <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
                </label>
              </>
            )}
          </>
        )}

        {/* Jump host (ProxyJump) — mobile-form parity. */}
        <label className="wide term-toggle">
          <input type="checkbox" checked={useJump} onChange={(e) => setUseJump(e.target.checked)} />
          {t('term.useJumpHost')}
        </label>
        {useJump && (
          <>
            <label className="term-field-host">
              {t('term.jumpHost')}
              <input value={jumpHost} onChange={(e) => setJumpHost(e.target.value)} placeholder="bastion.example.com" />
            </label>
            <label className="term-field-port">
              {t('term.jumpPort')}
              <input value={jumpPort} onChange={(e) => setJumpPort(e.target.value)} inputMode="numeric" />
            </label>
            <label className="term-field-user">
              {t('term.jumpUser')}
              <input value={jumpUser} onChange={(e) => setJumpUser(e.target.value)} placeholder={user.trim()} />
            </label>
            <label className="term-field-auth">
              {t('term.jumpAuth')}
              <div className="seg">
                <button
                  className={jumpAuth === 'password' ? 'seg-btn active' : 'seg-btn'}
                  onClick={() => setJumpAuth('password')}
                >
                  {t('term.password')}
                </button>
                <button className={jumpAuth === 'key' ? 'seg-btn active' : 'seg-btn'} onClick={() => setJumpAuth('key')}>
                  {t('term.privateKey')}
                </button>
              </div>
            </label>
            {jumpAuth === 'password' ? (
              <label className="term-field-credential">
                {t('term.jumpPassword')}
                <input
                  type="password"
                  value={jumpPassword}
                  onChange={(e) => setJumpPassword(e.target.value)}
                  placeholder={t('term.jumpPasswordHint')}
                />
              </label>
            ) : (
              <label className="term-field-credential">
                {t('term.useKey')}
                <select value={jumpKeyId} onChange={(e) => setJumpKeyId(e.target.value)}>
                  <option value="">{t('term.jumpPickKey')}</option>
                  {keys.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name} ({k.type})
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}

        {/* SOCKS5 proxy — the outermost hop (tunnels to the jump host when one
            is set, else to the target), mobile-form parity. */}
        <label className="wide term-toggle">
          <input type="checkbox" checked={useProxy} onChange={(e) => setUseProxy(e.target.checked)} />
          {t('term.useProxy')}
        </label>
        {useProxy && (
          <>
            <label className="term-field-host">
              {t('term.proxyHost')}
              <input value={proxyHost} onChange={(e) => setProxyHost(e.target.value)} placeholder="127.0.0.1" />
            </label>
            <label className="term-field-port">
              {t('term.proxyPort')}
              <input value={proxyPort} onChange={(e) => setProxyPort(e.target.value)} inputMode="numeric" />
            </label>
            <label className="term-field-user">
              {t('term.proxyUser')}
              <input value={proxyUser} onChange={(e) => setProxyUser(e.target.value)} />
            </label>
            <label className="term-field-credential">
              {t('term.proxyPassword')}
              <input type="password" value={proxyPassword} onChange={(e) => setProxyPassword(e.target.value)} />
            </label>
          </>
        )}

        {error !== null && <div className="error wide">{error}</div>}
        <div className="wide term-actions">
          <button disabled={host.trim() === '' || user.trim() === ''} onClick={() => void saveCurrent()}>
            {id !== null ? t('term.update') : t('term.save')}
          </button>
          {id !== null && <ConfirmButton label={t('term.delete')} danger onConfirm={() => void removeCurrent()} />}
          {/* One Cancel button at all times: idle it closes the form (guarded
              against unsaved edits, #313); while connecting it abandons the
              attempt (the form stays open for a retry) — the connect button
              shows the handshake phase (#319). */}
          {onCancel !== undefined && !busy && <button onClick={() => void attemptCancel()}>{t('common.cancel')}</button>}
          {busy && <button onClick={cancelConnect}>{t('common.cancel')}</button>}
          <span className="spacer" />
          <button className="primary" aria-busy={busy} disabled={!canConnect || busy} onClick={() => void connect()}>
            {busy && <span className="term-connecting-spinner" aria-hidden="true"><Icon name="refresh" size={14} /></span>}
            {busy ? (phase !== null ? t(PHASE_KEY[phase]) : t('term.connecting')) : t('term.connect')}
          </button>
        </div>
        <div className="term-note wide">{t('term.personalNote')}</div>
        {confirmNode}
      </div>
    </div>
  );
}
