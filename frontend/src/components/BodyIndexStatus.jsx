import { useStore } from '../store/index.js';
import { useSearchIndexStatus } from '../hooks/useSearchIndexStatus.js';

export default function BodyIndexStatus() {
  const active = useStore(s => s.accountsReady && Boolean(s.searchQuery.trim()));
  useSearchIndexStatus(active);
  return null;
}
