import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { useStore } from '../store/index.js';

export default function BodyIndexStatus() {
  const { t } = useTranslation();
  const accountId = useStore(s => s.selectedAccountId);
  const ready = useStore(s => s.accountsReady);
  const [accounts, setAccounts] = useState([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const load = async () => {
      try {
        const result = await api.bodyIndexStatus();
        if (!cancelled) { setAccounts(result.accounts); setError(false); }
      } catch { if (!cancelled) setError(true); }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [ready]);
  if (error) return <div role="status" style={{ padding: '4px 12px', fontSize: 11 }}>{t('search.indexUnavailable', 'Search indexing status unavailable')}</div>;
  const visible = accounts.filter(a => !accountId || a.account_id === accountId);
  if (!visible.length) return null;
  const headers = visible.reduce((n, a) => n + a.headers_loaded, 0);
  const bodies = visible.reduce((n, a) => n + a.bodies_searchable, 0);
  const failed = visible.reduce((n, a) => n + a.failed, 0);
  return <div role="status" title={visible.map(a => `${a.account_name}: ${a.bodies_searchable}/${a.headers_loaded}${a.last_error ? ` — ${a.last_error}` : ''}`).join('\n')}
    style={{ padding: '4px 12px', fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0 }}>
    {t('search.indexProgress', 'Headers: {{headers}} · Bodies searchable: {{bodies}}/{{headers}}', { headers, bodies })}
    {failed > 0 && ` · ${t('search.indexRetrying', 'Retrying: {{count}}', { count: failed })}`}
  </div>;
}
