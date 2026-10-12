import { useStore } from '../store/index.js';
import { useSearchIndexStatus } from '../hooks/useSearchIndexStatus.js';

export default function BodyIndexStatus() {
  const ready = useStore(s => s.accountsReady);
  useSearchIndexStatus(ready);
  return null;
}
