import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';

const labels = { offline: 'connection.offline', unavailable: 'connection.unavailable', connecting: 'connection.connecting', refreshing: 'connection.refreshing', refreshError: 'connection.refreshError', blocked: 'connection.blocked' };

export default function ConnectionStatus() {
  const { t } = useTranslation();
  const phase = useStore(state => state.connectionStatus.phase);
  if (phase === 'healthy') return null;
  const busy = phase === 'connecting' || phase === 'refreshing';
  return (
    <div data-connection-status={phase} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, flexShrink: 0, padding: '0 12px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', fontSize: 12 }}>
      <span role="status" aria-live="polite" aria-atomic="true" style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
        {busy && <span className="search-spinner" aria-hidden="true" style={{ width: 12, height: 12, flexShrink: 0 }} />}
        {t(labels[phase])}
      </span>
      {!busy && phase !== 'offline' && phase !== 'blocked' && <button disabled={busy || phase === 'offline'} onClick={() => window.dispatchEvent(new CustomEvent('mailflow:connection-retry'))} style={{ border: 'none', background: 'none', color: 'var(--accent)', minHeight: 44, minWidth: 44, padding: '6px 0', fontSize: 12, cursor: busy || phase === 'offline' ? 'default' : 'pointer', opacity: busy || phase === 'offline' ? 0.5 : 1 }}>{t('common.retry')}</button>}
    </div>
  );
}
