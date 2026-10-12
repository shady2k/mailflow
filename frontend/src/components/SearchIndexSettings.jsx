import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { useSearchIndexStatus } from '../hooks/useSearchIndexStatus.js';

const states = {
  paused: 'searchIndex.paused', complete: 'searchIndex.complete', indexing: 'searchIndex.indexing',
  queued: 'searchIndex.queued', retrying: 'searchIndex.retrying', connection_wait: 'searchIndex.connectionWait',
  sync_running: 'searchIndex.syncRunning', user_active: 'searchIndex.userActive',
};
const buttonStyle = {
  padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontSize: 12, cursor: 'pointer',
};

export default function SearchIndexSettings() {
  const { t, i18n } = useTranslation();
  const { accounts, error, loading, updatedAt, refresh } = useSearchIndexStatus();
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(false);
  const control = async (id, action) => {
    setBusy(id);
    setActionError(false);
    try { await api.controlBodyIndex(id, action); refresh(); }
    catch { setActionError(true); }
    finally { setBusy(null); }
  };
  return <section aria-label={t('searchIndex.title')} style={{ maxWidth: 720 }}>
    <h2 style={{ fontSize: 16, margin: '0 0 12px' }}>{t('searchIndex.title')}</h2>
    <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{t('searchIndex.description')}</p>
    <p style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.6 }}>{t('searchIndex.pauseHelp')}</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, margin: '16px 0' }}>
      <button type="button" style={buttonStyle} disabled={loading || !!busy} onClick={refresh}>
        {t(loading ? 'searchIndex.refreshing' : 'searchIndex.refresh')}
      </button>
      {updatedAt && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
        {t('searchIndex.updated', { time: updatedAt.toLocaleTimeString(i18n.language) })}
      </span>}
    </div>
    {(error || actionError) && <p role="alert" style={{ color: 'var(--red)', fontSize: 13 }}>
      {t(actionError ? 'searchIndex.actionFailed' : 'searchIndex.unavailable')}
    </p>}
    {!loading && !error && !accounts.length && <p>{t('searchIndex.noAccounts')}</p>}
    <div aria-live="polite">
      {accounts.map(account => <article key={account.account_id} style={{
        padding: 16, border: '1px solid var(--border)', borderRadius: 8, marginBottom: 12, background: 'var(--bg-secondary)',
      }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 14, overflowWrap: 'anywhere' }}>{account.account_name}</h3>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '8px 0' }}>
          {t(states[account.state] || 'searchIndex.queued')}
        </p>
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
          {t('searchIndex.coverage', { bodies: account.bodies_searchable, headers: account.headers_loaded, pending: account.pending, failed: account.failed })}
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button type="button" style={buttonStyle} disabled={!!busy} onClick={() => control(account.account_id, account.paused ? 'resume' : 'pause')}>
            {t(busy === account.account_id ? 'searchIndex.saving' : account.paused ? 'searchIndex.resume' : 'searchIndex.pause')}
          </button>
          <button type="button" style={buttonStyle} disabled={!!busy || !account.failed} onClick={() => control(account.account_id, 'retry')}>
            {t('searchIndex.retry')}
          </button>
        </div>
      </article>)}
    </div>
    <p style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.6 }}>{t('searchIndex.retryHelp')}</p>
  </section>;
}
