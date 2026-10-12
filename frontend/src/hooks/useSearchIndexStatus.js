import { useEffect, useRef, useState } from 'react';
import { api } from '../utils/api.js';

export function useSearchIndexStatus(enabled = true) {
  const [accounts, setAccounts] = useState([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [revision, setRevision] = useState(0);
  const progress = useRef(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let pending = false;
    const load = async () => {
      if (cancelled || pending) return;
      pending = true;
      setLoading(true);
      try {
        const result = await api.bodyIndexStatus();
        if (cancelled) return;
        const count = result.accounts.reduce((n, a) => n + a.bodies_searchable, 0);
        if (progress.current !== null && count > progress.current) window.dispatchEvent(new CustomEvent('mailflow:search_index_updated'));
        progress.current = count;
        setAccounts(result.accounts);
        setUpdatedAt(new Date());
        setError(false);
      } catch { if (!cancelled) setError(true); }
      finally { pending = false; if (!cancelled) setLoading(false); }
    };
    void load();
    const timer = setInterval(load, 5000);
    timer.unref?.();
    window.addEventListener('focus', load);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('focus', load); };
  }, [enabled, revision]);
  return { accounts, error, loading, updatedAt, refresh: () => setRevision(n => n + 1) };
}
