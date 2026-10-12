import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { useStore } from '../store/index.js';

export default function BodyIndexStatus({ accountId: accountIdOverride, silent = false, detailed = false }) {
  const { t } = useTranslation();
  const selectedAccountId = useStore(s => s.selectedAccountId);
  const accountId = accountIdOverride === undefined ? selectedAccountId : accountIdOverride;
  const reload = useRef(null);
  const ready = useStore(s => s.accountsReady);
  const progress = useRef(null);
  const [accounts, setAccounts] = useState([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let loading = false;
    const load = async () => {
      if (cancelled || loading) return;
      loading = true;
      try {
        const result = await api.bodyIndexStatus();
        if (!cancelled) {
          const count = result.accounts.reduce((n, a) => n + a.bodies_searchable, 0);
          if (progress.current !== null && count > progress.current) window.dispatchEvent(new window.CustomEvent('mailflow:search_index_updated'));
          progress.current = count;
          setAccounts(result.accounts); setError(false);
        }
      } catch { if (!cancelled) setError(true); }
      finally { loading = false; }
    };
    reload.current = load;
    void load();
    const timer = setInterval(load, 5000);
    timer.unref?.();
    return () => { cancelled = true; reload.current = null; clearInterval(timer); };
  }, [ready]);
  if (silent) return null;
  const refreshButton = detailed && <button type="button" onClick={() => reload.current?.()} style={{ marginTop: 8, padding: '6px 10px', cursor: 'pointer' }}>{t('search.indexRefresh', 'Refresh status')}</button>;
  if (error) return <div role="status" style={{ padding: '4px 12px', fontSize: 11 }}>{t('search.indexUnavailable', 'Search indexing status unavailable')}{refreshButton}</div>;
  const visible = accounts.filter(a => !accountId || a.account_id === accountId);
  if (!visible.length) return null;
  const headers = visible.reduce((n, a) => n + a.headers_loaded, 0);
  const bodies = visible.reduce((n, a) => n + a.bodies_searchable, 0);
  const failed = visible.reduce((n, a) => n + a.failed, 0);
  return <div role="status" data-search-index-settings={detailed || undefined} title={visible.map(a => `${a.account_name}: ${a.bodies_searchable}/${a.headers_loaded}${a.last_error ? ` — ${a.last_error}` : ''}`).join('\n')}
    style={{ padding: detailed ? '12px' : '4px 12px', fontSize: detailed ? 13 : 11, color: 'var(--text-secondary)', flexShrink: 0 }}>
    {detailed && <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{t('search.indexSettingsTitle', 'Search indexing')}</div>}
    {t('search.indexProgress', 'Headers: {{headers}} · Bodies searchable: {{bodies}}/{{headers}}', { headers, bodies })}
    {failed > 0 && ` · ${t('search.indexRetrying', 'Retrying: {{count}}', { count: failed })}`}
    {detailed && <>
      <p>{t('search.indexScope', 'Coverage includes headers already synchronized; pending bodies are indexed automatically with retries.')}</p>
      {visible.map(a => <div key={a.account_id} style={{ marginTop: 6 }}>
        <strong>{a.account_name}</strong>: {a.bodies_searchable}/{a.headers_loaded} · {t('search.indexPending', 'Pending: {{count}}', { count: a.pending })}
        {a.failed > 0 && ` · ${t('search.indexRetrying', 'Retrying: {{count}}', { count: a.failed })}`}
        {a.last_error && <div style={{ color: 'var(--red)', overflowWrap: 'anywhere' }}>{a.last_error}</div>}
      </div>)}
      {refreshButton}
    </>}
  </div>;
}
