export function displayInboxFolderCounts(folders, counts, pending, now = Date.now()) {
  // Both endpoints observe INBOX; share its account optimism without rewriting raw folder snapshots.
  return Object.fromEntries(Object.entries(folders).map(([accountId, rows]) => {
    const count = counts.byAccount?.[accountId];
    const snapshot = counts.snapshots?.[accountId];
    const optimistic = pending[accountId]?.expiresAt > now;
    if (!Number.isFinite(count) || (!optimistic && !snapshot?.known)) return [accountId, rows];
    const revision = BigInt(snapshot?.attemptRevision || snapshot?.revision || '0');
    return [accountId, rows.map(folder => {
      if (folder.path !== 'INBOX') return folder;
      const folderRevision = BigInt(folder.status_attempt_revision || folder.server_count_revision || '0');
      if (!optimistic && folderRevision > revision) return folder;
      return { ...folder, unread_count: count, counts_known: true,
        counts_stale: !!snapshot?.stale, server_counts_at: snapshot?.observedAt ?? folder.server_counts_at };
    })];
  }));
}
