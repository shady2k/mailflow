import { useTranslation } from 'react-i18next';

export default function InboxPanels({ singlePane, selectedMessageId, onBack, list, reader, divider }) {
  const { t } = useTranslation();
  const paneStyle = { flex: 1, minWidth: 0, minHeight: 0, height: '100%', flexDirection: 'column' };
  return <>
    <div data-inbox-panel="list" style={singlePane ? { ...paneStyle, display: selectedMessageId ? 'none' : 'flex' } : { display: 'contents' }}>{list}</div>
    {!singlePane && divider}
    <div data-inbox-panel="reader" style={singlePane ? { ...paneStyle, display: selectedMessageId ? 'flex' : 'none' } : { display: 'contents' }}>
      {singlePane && selectedMessageId && <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
        <button onClick={onBack} style={{ border: 'none', background: 'none', color: 'var(--text-primary)', cursor: 'pointer', padding: '6px 10px' }}>
          ← {t('message.backToList', 'Back to list')}
        </button>
      </div>}
      {reader}
    </div>
  </>;
}
