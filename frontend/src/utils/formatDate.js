import i18n from 'i18next';
import { htmlLang } from './browserLanguage.js';

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function localizedDate(value, options) {
  const date = validDate(value);
  if (!date) return '';
  return new Intl.DateTimeFormat(htmlLang(i18n.resolvedLanguage || i18n.language || 'en'), options).format(date);
}

export const formatDateTime = (value, compact = false) => localizedDate(value, {
  month: 'short', day: 'numeric', ...(compact ? {} : { year: 'numeric' }),
  hour: 'numeric', minute: '2-digit',
});
export const formatTimestamp = value => localizedDate(value, {
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
});
export const formatTime = value => localizedDate(value, { hour: 'numeric', minute: '2-digit' });
export const formatCalendarDate = value => localizedDate(value, { year: 'numeric', month: 'numeric', day: 'numeric' });

// Compare calendar days in the browser's timezone, including days around DST changes.
export function formatDate(dateStr, now = new Date()) {
  const d = validDate(dateStr);
  if (!d) return '';
  const sameDay = other => d.getFullYear() === other.getFullYear()
    && d.getMonth() === other.getMonth() && d.getDate() === other.getDate();
  if (sameDay(now)) return formatTime(d);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(yesterday)) {
    return new Intl.RelativeTimeFormat(htmlLang(i18n.resolvedLanguage || i18n.language || 'en'), { numeric: 'auto' }).format(-1, 'day');
  }
  return localizedDate(d, {
    month: 'short', day: 'numeric', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}
