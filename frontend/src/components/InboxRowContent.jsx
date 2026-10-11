import { useTranslation } from 'react-i18next';
import { formatDate } from '../utils/formatDate.js';

export default function InboxRowContent({ message, unread, checked, onToggleSelect, onStar, showPreview, count = 1, onToggleThread, expanded }) {
  const { t } = useTranslation();
  const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 };
  return <div data-inbox-row style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, minHeight: 26, fontSize: 13, fontWeight: unread ? 600 : 400 }}>
    <input type="checkbox" aria-label={t('messageList.selectMessages')} checked={checked} onChange={() => onToggleSelect(message.id)}
      onClick={e => e.stopPropagation()} style={{ flexShrink: 0, accentColor: 'var(--accent)' }} />
    <button aria-label={t('message.star', 'Star message')} aria-pressed={!!message.is_starred} onClick={e => { e.stopPropagation(); onStar(e, message); }}
      style={{ padding: 0, background: 'none', border: 'none', cursor: 'pointer', color: message.is_starred ? 'var(--amber)' : 'var(--text-tertiary)', flexShrink: 0 }}>★</button>
    <span title={message.from_email} style={{ ...ellipsis, width: '22%', maxWidth: 220, flexShrink: 0 }}>{message.from_name || message.from_email || t('common.unknown')}</span>
    {count > 1 && <button aria-expanded={expanded} aria-label={t('messageList.showAll')} onClick={e => { e.stopPropagation(); onToggleThread(); }}
      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', flexShrink: 0 }}>({count})</button>}
    <div style={{ ...ellipsis, flex: 1 }}>
      <span>{message.subject || t('message.noSubject')}</span>
      {showPreview && message.snippet && <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}> — {message.snippet}</span>}
    </div>
    {message.has_attachments && <span aria-label={t('message.attachment', { count: 1 })} style={{ flexShrink: 0 }}>⌁</span>}
    <span style={{ whiteSpace: 'nowrap', color: 'var(--text-secondary)', fontSize: 11, flexShrink: 0 }}>{formatDate(message.date)}</span>
  </div>;
}
