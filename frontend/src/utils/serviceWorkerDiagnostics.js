// Query the executing worker, not a newly downloaded /sw.js. Old workers may not reply.
export async function collectServiceWorkerDiagnostics({
  serviceWorker = globalThis.navigator?.serviceWorker,
  Channel = globalThis.MessageChannel,
  timeoutMs = 1500,
} = {}) {
  if (!serviceWorker || !Channel) return { available: false };
  let channel, timer, expired = false;
  const timeout = new Promise(resolve => { timer = setTimeout(() => { expired = true; resolve({ available: true, reason: 'worker_no_reply' }); }, timeoutMs); });
  try {
    return await Promise.race([timeout, (async () => {
      const registration = await serviceWorker.getRegistration();
      if (expired) return { available: true, reason: 'worker_no_reply' };
      const worker = serviceWorker.controller || registration?.active;
      const states = { controlled: Boolean(serviceWorker.controller),
        active: registration?.active?.state || null, waiting: registration?.waiting?.state || null,
        installing: registration?.installing?.state || null };
      if (!worker) return { available: true, ...states, reason: 'no_active_worker' };
      channel = new Channel();
      return await new Promise(resolve => {
        channel.port1.onmessage = event => resolve({ available: true, ...states, runtime: event.data });
        worker.postMessage({ type: 'mailflow:sw_diagnostics' }, [channel.port2]);
      });
    })()]);
  } catch { return { available: true, reason: 'inspection_failed' }; }
  finally { clearTimeout(timer); channel?.port1.close(); channel?.port2.close(); }
}
