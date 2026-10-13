export function createLatestRequest({ onIdle = () => {} } = {}) {
  let sequence = 0, scope = 0, pending = false, queued = null;
  const schedule = callback => {
    if (pending) { queued = callback; return; }
    const scheduledScope = scope;
    Promise.resolve().then(() => {
      if (scope !== scheduledScope) return;
      if (pending) { queued = callback; return; }
      return callback();
    }).catch(() => {});
  };
  return {
    get pending() { return pending; },
    schedule,
    invalidate: () => { sequence += 1; scope += 1; pending = false; queued = null; },
    run: async (request, apply) => {
      const current = ++sequence;
      pending = true;
      try {
        const value = await request();
        if (current !== sequence) return false;
        apply(value);
        return true;
      } finally {
        if (current === sequence) {
          pending = false;
          const callback = queued; queued = null;
          if (callback) schedule(callback);
          onIdle();
        }
      }
    },
  };
}
