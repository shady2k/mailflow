import { useTranslation } from 'react-i18next';
const MASKED = '••••••••';
export default function AiHeadersEditor({ headers, onChange, inputStyle }) {
  const { t } = useTranslation();
  const rows = headers?.length ? headers : [{ name: '', value: '' }];
  const change = (index, key, value) => onChange(rows.map((row, i) => i === index ? { ...row, [key]: value } : row));
  return <div data-ai-headers style={{ marginBottom: 18 }}>
    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>{t('admin.ai.headersTitle')}</div>
    <table style={{ width: '100%', tableLayout: 'fixed', borderSpacing: '0 6px' }}>
      <thead><tr style={{ textAlign: 'left', fontSize: 11, color: 'var(--text-tertiary)' }}>
        <th style={{ width: '38%', fontWeight: 400 }}>{t('admin.ai.headerName')}</th><th style={{ fontWeight: 400 }}>{t('admin.ai.headerValue')}</th><th style={{ width: 28 }} />
      </tr></thead>
      <tbody>{rows.map((row, index) => <tr key={index}>
        <td style={{ paddingRight: 8 }}><input aria-label={t('admin.ai.headerName')} value={row.name} maxLength={128} placeholder="x-opencode-session" onChange={e => change(index, 'name', e.target.value)} style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }} /></td>
        <td style={{ paddingRight: 8 }}><input aria-label={t('admin.ai.headerValue')} type="password" autoComplete="new-password" value={row.value === MASKED ? '' : row.value} maxLength={2048} placeholder={row.value === MASKED ? t('admin.ai.headerStored') : '{session_id}'} onChange={e => change(index, 'value', e.target.value)} style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }} /></td>
        <td><button type="button" aria-label={t('admin.ai.headerRemove')} title={t('admin.ai.headerRemove')} onClick={() => onChange(rows.filter((_, i) => i !== index))} style={{ background: 'none', border: 'none', padding: 4, color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 6h18M9 6V4h6v2M6 6l1 14h10l1-14M10 10v6M14 10v6" /></svg>
        </button></td>
      </tr>)}</tbody>
    </table>
    <button type="button" disabled={rows.length >= 20} onClick={() => onChange([...rows, { name: '', value: '' }])} style={{ marginTop: 6, padding: '6px 10px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12 }}>＋ {t('admin.ai.headerAdd')}</button>
    <div style={{ marginTop: 8, fontSize: 11, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>{t('admin.ai.headersHint')}</div>
  </div>;
}
