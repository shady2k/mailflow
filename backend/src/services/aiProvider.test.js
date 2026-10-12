import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AI_PROVIDER_API_KEY,
  AI_PROVIDER_CHATGPT,
  MASKED_API_KEY,
  createAiProvider,
  normalizeAiConfig,
} from './aiProvider.js';

const encoder = new TextEncoder();

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(chunks, { status = 200, close = true, onCancel } = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      if (close) controller.close();
    },
    cancel(reason) { onCancel?.(reason); },
  }), { status, headers: { 'content-type': 'text/event-stream' } });
}

function completionEvent(delta) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;
}

function memorySettings(initial) {
  let stored = initial == null ? null : JSON.stringify(initial);
  const queryFn = vi.fn(async (sql, params = []) => {
    if (/SELECT value FROM system_settings/i.test(sql)) {
      return { rows: stored == null ? [] : [{ value: stored }] };
    }
    if (/INSERT INTO system_settings/i.test(sql)) {
      stored = params[0];
      return { rows: [], rowCount: 1 };
    }
    if (/DELETE FROM system_settings/i.test(sql)) {
      stored = null;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { queryFn, read: () => stored == null ? null : JSON.parse(stored) };
}

function factory({ initial, ...overrides } = {}) {
  const settings = memorySettings(initial);
  const deps = {
    queryFn: settings.queryFn,
    encryptFn: (value) => `encrypted:${value}`,
    decryptFn: (value) => value?.replace(/^encrypted:/, ''),
    validateHostFn: vi.fn().mockResolvedValue(null),
    getConnectionPolicyFn: vi.fn().mockResolvedValue({ allowPrivateHosts: false }),
    fetchFn: vi.fn(),
    getCodexAccessFn: vi.fn().mockResolvedValue({ accessToken: 'codex-access', accountId: 'acct_123' }),
    getCodexStatusFn: vi.fn().mockResolvedValue({ connected: true, state: 'connected' }),
    streamCodexResponsesFn: vi.fn(),
    completeCodexTextFn: vi.fn().mockResolvedValue('codex text'),
    ...overrides,
  };
  return { provider: createAiProvider(deps), settings, deps };
}

async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('normalizeAiConfig', () => {
  it('normalizes legacy flat settings into API-key mode without changing values', () => {
    expect(normalizeAiConfig({
      enabled: true,
      baseUrl: 'http://ollama:11434/v1',
      apiKey: 'encrypted:key',
      model: 'llama3',
      features: { compose: false, summarize: true },
    })).toEqual({
      enabled: true,
      provider: AI_PROVIDER_API_KEY,
      apiKeyConfig: {
        baseUrl: 'http://ollama:11434/v1', apiKey: 'encrypted:key', model: 'llama3',
      },
      chatgptConfig: { model: 'gpt-5.6-luna' },
      features: { compose: false, summarize: true },
    });
  });

  it('normalizes the new shape and defaults feature flags to enabled', () => {
    expect(normalizeAiConfig({
      enabled: false,
      provider: AI_PROVIDER_CHATGPT,
      apiKeyConfig: { baseUrl: 'https://api.example/v1/', apiKey: null, model: 'api-model' },
      chatgptConfig: { model: 'gpt-5.4' },
    })).toEqual({
      enabled: false,
      provider: AI_PROVIDER_CHATGPT,
      apiKeyConfig: { baseUrl: 'https://api.example/v1', apiKey: null, model: 'api-model' },
      chatgptConfig: { model: 'gpt-5.4' },
      features: { compose: true, summarize: true },
    });
  });
});

describe('configuration persistence', () => {
  it.each([MASKED_API_KEY, ''])(
    'preserves the encrypted API key while switching to ChatGPT with input %j',
    async (apiKeyInput) => {
      const { provider, settings } = factory({
        initial: {
          enabled: true,
          provider: AI_PROVIDER_API_KEY,
          apiKeyConfig: { baseUrl: 'https://api.example/v1', apiKey: 'encrypted:original-key', model: 'api-model' },
          chatgptConfig: { model: 'gpt-5.4-mini' },
          features: { compose: true, summarize: true },
        },
      });

      const saved = await provider.saveAiConfig({
        enabled: true,
        provider: AI_PROVIDER_CHATGPT,
        apiKeyConfig: { baseUrl: 'https://api.example/v1', apiKey: apiKeyInput, model: 'api-model' },
        chatgptConfig: { model: 'gpt-5.4' },
        features: { compose: true, summarize: false },
      });

      expect(settings.read().apiKeyConfig.apiKey).toBe('encrypted:original-key');
      expect(saved.apiKeyConfig.apiKey).toBe(MASKED_API_KEY);
      expect(saved.provider).toBe(AI_PROVIDER_CHATGPT);
    },
  );

  it('encrypts a replacement API key and never returns it', async () => {
    const { provider, settings } = factory();
    const saved = await provider.saveAiConfig({
      enabled: true,
      provider: AI_PROVIDER_API_KEY,
      apiKeyConfig: { baseUrl: 'https://api.example/v1/', apiKey: 'new-secret', model: 'model' },
      chatgptConfig: { model: 'gpt-5.4-mini' },
    });
    expect(settings.read().apiKeyConfig.apiKey).toBe('encrypted:new-secret');
    expect(saved.apiKeyConfig.apiKey).toBe(MASKED_API_KEY);
    expect(JSON.stringify(saved)).not.toContain('new-secret');
  });

  it('rejects unknown providers and incomplete selected-provider settings', async () => {
    const { provider } = factory();
    await expect(provider.saveAiConfig({ enabled: true, provider: 'other' }))
      .rejects.toMatchObject({ status: 400 });
    await expect(provider.saveAiConfig({
      enabled: true,
      provider: AI_PROVIDER_API_KEY,
      apiKeyConfig: { baseUrl: '', model: '' },
      chatgptConfig: { model: 'gpt-5.4-mini' },
    })).rejects.toThrow(/base URL.*model/i);
    await expect(provider.saveAiConfig({
      enabled: true,
      provider: AI_PROVIDER_CHATGPT,
      apiKeyConfig: { baseUrl: '', model: '' },
      chatgptConfig: { model: '' },
    })).rejects.toThrow(/model/i);
  });

  it('retains existing private-host policy validation for API-key URLs', async () => {
    const validateHostFn = vi.fn().mockResolvedValue('Host cannot be a private or reserved IP address');
    const getConnectionPolicyFn = vi.fn().mockResolvedValue({ allowPrivateHosts: false });
    const { provider } = factory({ validateHostFn, getConnectionPolicyFn });

    await expect(provider.saveAiConfig({
      enabled: true,
      provider: AI_PROVIDER_API_KEY,
      apiKeyConfig: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'm' },
      chatgptConfig: { model: 'gpt-5.4-mini' },
    })).rejects.toThrow(/private or reserved/i);
    expect(getConnectionPolicyFn).toHaveBeenCalledTimes(1);
    expect(validateHostFn).toHaveBeenCalledWith('127.0.0.1', { allowPrivate: false });
  });

  it('does not revalidate the inactive API-key URL when switching to ChatGPT', async () => {
    const validateHostFn = vi.fn().mockResolvedValue('Host cannot be a private or reserved IP address');
    const getConnectionPolicyFn = vi.fn().mockResolvedValue({ allowPrivateHosts: false });
    const { provider } = factory({ validateHostFn, getConnectionPolicyFn });

    await expect(provider.saveAiConfig({
      enabled: true,
      provider: AI_PROVIDER_CHATGPT,
      apiKeyConfig: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'm' },
      chatgptConfig: { model: 'gpt-5.4-mini' },
    })).resolves.toMatchObject({ provider: AI_PROVIDER_CHATGPT });
    expect(getConnectionPolicyFn).not.toHaveBeenCalled();
    expect(validateHostFn).not.toHaveBeenCalled();
  });
});

describe('API-key provider regression', () => {
  const legacy = {
    enabled: true,
    baseUrl: 'https://api.example/v1',
    apiKey: 'encrypted:api-secret',
    model: 'legacy-model',
    features: { compose: true, summarize: true },
  };

  it('completes text with the legacy OpenAI-compatible request contract', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: 'provider text' } }],
    }));
    const { provider } = factory({ initial: legacy, fetchFn });

    await expect(provider.completeText([{ role: 'user', content: 'Hi' }], { maxTokens: 12 }))
      .resolves.toBe('provider text');
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.example/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer api-secret');
    expect(JSON.parse(init.body)).toEqual({
      model: 'legacy-model',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 12,
      stream: false,
    });
  });

  it('supports providers with no API key', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const { provider } = factory({ initial: { ...legacy, apiKey: null }, fetchFn });
    await provider.completeText([{ role: 'user', content: 'Hi' }]);
    expect(fetchFn.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  });

  it('surfaces the finish reason when a real completion returns null content', async () => {
    // Reasoning model: all output went to reasoning, content is null (#401).
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ finish_reason: 'length', message: { content: null, reasoning_content: 'thinking…' } }],
    }));
    const { provider } = factory({ initial: legacy, fetchFn });
    const err = await provider.completeText([{ role: 'user', content: 'Hi' }], { maxTokens: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(502);
    expect(err.expose).toBe(true);
    expect(err.message).toMatch(/empty completion \(finish_reason: length\)/);
  });

  it('rejects a malformed completion with no choices', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ notChoices: true }));
    const { provider } = factory({ initial: legacy, fetchFn });
    const err = await provider.completeText([{ role: 'user', content: 'Hi' }]).catch((e) => e);
    expect(err.message).toMatch(/invalid completion/);
    expect(err.expose).toBe(true);
  });

  it('exposes provider HTTP errors with their status and detail', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'bad model' } }, 400));
    const { provider } = factory({ initial: legacy, fetchFn });
    const err = await provider.completeText([{ role: 'user', content: 'Hi' }]).catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.expose).toBe(true);
    expect(err.message).toMatch(/AI provider error \(400\).*bad model/);
  });

  it('passes the connection test when a reasoning model returns empty content', async () => {
    // The exact #401 case: null content + finish_reason "length" must not fail
    // the connection test, and the test must use the small allowEmpty budget.
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ finish_reason: 'length', message: { content: null, reasoning_content: 'reasoning…' } }],
    }));
    const { provider } = factory({ initial: legacy, fetchFn });
    await expect(provider.testAiProvider()).resolves.toEqual({ ok: true });
    expect(JSON.parse(fetchFn.mock.calls[0][1].body).max_tokens).toBe(16);
  });

  it('passes the connection test against a provider that rejects unknown fields', async () => {
    // OpenAI answers an unknown top-level field with a 400 instead of ignoring it.
    const known = new Set(['model', 'messages', 'max_tokens', 'stream']);
    const fetchFn = vi.fn(async (_url, init) => {
      const unknown = Object.keys(JSON.parse(init.body)).find((key) => !known.has(key));
      return unknown
        ? jsonResponse({ error: { message: `Unrecognized request argument supplied: ${unknown}` } }, 400)
        : jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    });
    const { provider } = factory({ initial: legacy, fetchFn });
    await expect(provider.testAiProvider()).resolves.toEqual({ ok: true });
  });

  it('keeps the provider timeout active while reading the response body', async () => {
    vi.useFakeTimers();
    let requestSignal;
    const fetchFn = vi.fn((_url, init) => {
      requestSignal = init.signal;
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
        },
      })));
    });
    const { provider } = factory({ initial: legacy, fetchFn });
    const completion = provider.completeText([{ role: 'user', content: 'Hi' }]);
    const rejection = expect(completion).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(requestSignal.aborted).toBe(true);
    await rejection;
  });

  it('normalizes split Chat Completions SSE into text deltas', async () => {
    const fetchFn = vi.fn().mockResolvedValue(sseResponse([
      completionEvent('Hel').slice(0, 15),
      completionEvent('Hel').slice(15),
      completionEvent('lo'),
      'data: [DONE]\n\n',
    ]));
    const { provider } = factory({ initial: legacy, fetchFn });
    await expect(collect(provider.streamChat([{ role: 'user', content: 'Hi' }])))
      .resolves.toEqual(['Hel', 'lo']);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.example/v1/chat/completions');
    expect(JSON.parse(init.body)).toEqual({
      model: 'legacy-model',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
  });

  it('cancels the upstream stream when the caller aborts', async () => {
    let cancelled = false;
    const fetchFn = vi.fn().mockResolvedValue(sseResponse(
      [completionEvent('first')],
      { close: false, onCancel: () => { cancelled = true; } },
    ));
    const { provider } = factory({ initial: legacy, fetchFn });
    const controller = new AbortController();
    const iterator = provider.streamChat([{ role: 'user', content: 'Hi' }], {
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: 'first' });
    controller.abort();
    await expect(iterator.next()).rejects.toThrow(/aborted/i);
    expect(cancelled).toBe(true);
  });

  it('bounds non-2xx provider errors without exposing the configured key', async () => {
    let cancelled = false;
    const fetchFn = vi.fn().mockResolvedValue(sseResponse(
      [JSON.stringify({ error: { message: `api-secret ${'x'.repeat(20_000)}secret-tail` } })],
      { status: 503, close: false, onCancel: () => { cancelled = true; } },
    ));
    const { provider } = factory({ initial: legacy, fetchFn });
    const error = await collect(provider.streamChat([{ role: 'user', content: 'Hi' }])).catch((cause) => cause);
    expect(error.message).toMatch(/503/);
    expect(error.message.length).toBeLessThan(9000);
    expect(error.message).not.toMatch(/secret-tail|api-secret/);
    expect(cancelled).toBe(true);
  });
});

describe('ChatGPT provider dispatch', () => {
  const chatgpt = {
    enabled: true,
    provider: AI_PROVIDER_CHATGPT,
    apiKeyConfig: { baseUrl: 'https://api.example/v1', apiKey: 'encrypted:fallback-key', model: 'api-model' },
    chatgptConfig: { model: 'gpt-5.4' },
    features: { compose: true, summarize: true },
  };

  it('uses subscription credentials for completed text and never falls back to fetch', async () => {
    const completeCodexTextFn = vi.fn().mockResolvedValue('subscription text');
    const fetchFn = vi.fn();
    const { provider, deps } = factory({ initial: chatgpt, completeCodexTextFn, fetchFn });

    await expect(provider.completeText([{ role: 'user', content: 'Hi' }]))
      .resolves.toBe('subscription text');
    expect(deps.getCodexAccessFn).toHaveBeenCalledTimes(1);
    expect(completeCodexTextFn).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: 'codex-access', accountId: 'acct_123', model: 'gpt-5.4',
    }));
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('force-refreshes and retries once when Codex rejects a cached access token', async () => {
    const unauthorized = Object.assign(new Error('rejected token'), { status: 401 });
    const completeCodexTextFn = vi.fn()
      .mockRejectedValueOnce(unauthorized)
      .mockResolvedValueOnce('refreshed text');
    const getCodexAccessFn = vi.fn()
      .mockResolvedValueOnce({ accessToken: 'stale', accountId: 'acct_123' })
      .mockResolvedValueOnce({ accessToken: 'fresh', accountId: 'acct_123' });
    const { provider } = factory({
      initial: chatgpt,
      completeCodexTextFn,
      getCodexAccessFn,
    });

    await expect(provider.completeText([{ role: 'user', content: 'Hi' }]))
      .resolves.toBe('refreshed text');
    expect(getCodexAccessFn).toHaveBeenNthCalledWith(1);
    expect(getCodexAccessFn).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(completeCodexTextFn).toHaveBeenCalledTimes(2);
    expect(completeCodexTextFn.mock.calls[1][0]).toMatchObject({ accessToken: 'fresh' });
  });

  it('force-refreshes a rejected Codex stream before any text is emitted', async () => {
    const unauthorized = Object.assign(new Error('rejected token'), { status: 401 });
    const streamCodexResponsesFn = vi.fn()
      .mockImplementationOnce(async function* rejected() { yield await Promise.reject(unauthorized); })
      .mockImplementationOnce(async function* refreshed() { yield 'fresh text'; });
    const getCodexAccessFn = vi.fn()
      .mockResolvedValueOnce({ accessToken: 'stale', accountId: 'acct_123' })
      .mockResolvedValueOnce({ accessToken: 'fresh', accountId: 'acct_123' });
    const { provider } = factory({
      initial: chatgpt,
      streamCodexResponsesFn,
      getCodexAccessFn,
    });

    await expect(collect(provider.streamChat([{ role: 'user', content: 'Hi' }])))
      .resolves.toEqual(['fresh text']);
    expect(getCodexAccessFn).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(streamCodexResponsesFn.mock.calls[1][0]).toMatchObject({ accessToken: 'fresh' });
  });

  it('does not replay a Codex stream after text has already been emitted', async () => {
    const unauthorized = Object.assign(new Error('late rejection'), { status: 401 });
    const streamCodexResponsesFn = vi.fn(async function* partial() {
      yield 'partial';
      throw unauthorized;
    });
    const getCodexAccessFn = vi.fn()
      .mockResolvedValue({ accessToken: 'stale', accountId: 'acct_123' });
    const { provider } = factory({
      initial: chatgpt,
      streamCodexResponsesFn,
      getCodexAccessFn,
    });

    await expect(collect(provider.streamChat([{ role: 'user', content: 'Hi' }])))
      .rejects.toThrow(/late rejection/i);
    expect(getCodexAccessFn).toHaveBeenCalledTimes(1);
    expect(streamCodexResponsesFn).toHaveBeenCalledTimes(1);
  });

  it('streams only through Codex and propagates reconnect errors without fallback', async () => {
    async function* codexStream() { yield 'one'; yield 'two'; }
    const streamCodexResponsesFn = vi.fn(() => codexStream());
    const fetchFn = vi.fn();
    const { provider } = factory({ initial: chatgpt, streamCodexResponsesFn, fetchFn });
    await expect(collect(provider.streamChat([{ role: 'user', content: 'Hi' }])))
      .resolves.toEqual(['one', 'two']);
    expect(fetchFn).not.toHaveBeenCalled();

    const reconnect = factory({
      initial: chatgpt,
      fetchFn,
      getCodexAccessFn: vi.fn().mockRejectedValue(new Error('reconnect required')),
    }).provider;
    await expect(collect(reconnect.streamChat([{ role: 'user', content: 'Hi' }])))
      .rejects.toThrow(/reconnect/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('status and provider test', () => {
  it('reports a valid legacy API-key provider as enabled', async () => {
    const { provider } = factory({ initial: {
      enabled: true, baseUrl: 'https://api.example/v1', model: 'm', features: { compose: true },
    } });
    await expect(provider.getAiStatus()).resolves.toEqual({
      enabled: true,
      provider: AI_PROVIDER_API_KEY,
      features: { compose: true, summarize: true },
      reconnectRequired: false,
    });
  });

  it.each([
    [{ connected: false, state: 'disconnected', reconnectRequired: false }, false],
    [{ connected: false, state: 'reconnect_required', reconnectRequired: true }, true],
  ])('reflects masked ChatGPT connection state %j', async (codexStatus, reconnectRequired) => {
    const { provider } = factory({
      initial: {
        enabled: true,
        provider: AI_PROVIDER_CHATGPT,
        apiKeyConfig: { baseUrl: '', apiKey: null, model: '' },
        chatgptConfig: { model: 'gpt-5.4' },
      },
      getCodexStatusFn: vi.fn().mockResolvedValue(codexStatus),
    });
    await expect(provider.getAiStatus()).resolves.toMatchObject({
      enabled: false,
      provider: AI_PROVIDER_CHATGPT,
      reconnectRequired,
      connection: codexStatus,
    });
  });

  it('tests whichever provider is selected through completeText', async () => {
    const { provider } = factory({ initial: {
      enabled: true,
      provider: AI_PROVIDER_CHATGPT,
      apiKeyConfig: { baseUrl: '', apiKey: null, model: '' },
      chatgptConfig: { model: 'gpt-5.4' },
    } });
    await expect(provider.testAiProvider()).resolves.toEqual({ ok: true });
  });
});

describe('additional encrypted API headers and task scope', () => {
  const initial = { provider: AI_PROVIDER_API_KEY, apiKeyConfig: { baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic-model', apiKey: 'encrypted:synthetic-key' } };
  it('stores encrypted values, redacts GET/save responses, preserves masks and supports explicit removal', async () => {
    const { provider, settings } = factory({ initial });
    const input = { ...initial, apiKeyConfig: { ...initial.apiKeyConfig, apiKey: MASKED_API_KEY, headers: [{ name: 'X-Custom-Token', value: 'synthetic-secret' }, { name: 'x-opencode-session', value: '{session_id}' }] } };
    const publicSaved = await provider.saveAiConfig(input);
    expect(settings.read().apiKeyConfig.headers[0].value).toBe('encrypted:synthetic-secret');
    expect(publicSaved.apiKeyConfig.headers.every(h => h.value === MASKED_API_KEY)).toBe(true);
    expect(await provider.getAdminAiConfig()).toEqual(publicSaved);
    await provider.saveAiConfig(publicSaved);
    expect(settings.read().apiKeyConfig.headers[0].value).toBe('encrypted:synthetic-secret');
    await provider.saveAiConfig({ ...publicSaved, apiKeyConfig: { ...publicSaved.apiKeyConfig, headers: [] } });
    expect(settings.read().apiKeyConfig.headers).toEqual([]);
  });
  it.each([
    [{ name: '', value: 'value' }], [{ name: 'bad\r\nname', value: 'value' }],
    [{ name: 'x-ok', value: 'bad\r\nInjected: value' }],
    [{ name: 'x-ok', value: 'value' }, { name: 'X-OK', value: 'other' }],
    ...['Host', 'Content-Length', 'Connection', 'Authorization', 'Proxy-Authorization', 'X-API-Key', 'Cookie', 'Content-Type'].map(name => [{ name, value: 'value' }]),
    [{ name: 'x-ok', value: 'v'.repeat(2049) }], Array.from({ length: 21 }, (_, i) => ({ name: 'x-'+i, value: '' })),
  ].map(headers => [headers]))('rejects invalid/reserved/injected header configuration without a provider request', async headers => {
    const { provider, deps } = factory({ initial });
    await expect(provider.saveAiConfig({ ...initial, apiKeyConfig: { ...initial.apiKeyConfig, headers } })).rejects.toMatchObject({ status: 400 });
    expect(deps.fetchFn).not.toHaveBeenCalled();
  });
  it('preserves case-only masked edits, requires replacement for renamed masked values, and enforces total size', async () => {
    const { provider, settings } = factory({ initial });
    const saved = await provider.saveAiConfig({ ...initial, apiKeyConfig: { ...initial.apiKeyConfig, headers: [{ name: 'x-secret', value: 'public-synthetic-value' }] } });
    await provider.saveAiConfig({ ...saved, apiKeyConfig: { ...saved.apiKeyConfig, headers: [{ name: 'X-SECRET', value: MASKED_API_KEY }] } });
    expect(settings.read().apiKeyConfig.headers[0].value).toBe('encrypted:public-synthetic-value');
    const before = settings.read();
    await expect(provider.saveAiConfig({ ...saved, apiKeyConfig: { ...saved.apiKeyConfig, headers: [{ name: 'x-renamed', value: MASKED_API_KEY }] } })).rejects.toMatchObject({ status: 400 });
    expect(settings.read()).toEqual(before);
    const headers = Array.from({ length: 20 }, (_, i) => ({ name: 'x-header-'+i, value: 'v'.repeat(1000) }));
    await expect(provider.saveAiConfig({ ...saved, apiKeyConfig: { ...saved.apiKeyConfig, headers } })).rejects.toMatchObject({ status: 400 });
  });
  it('tests the edited unsaved form without writing settings or returning secrets', async () => {
    const { provider, settings, deps } = factory({ initial, fetchFn: vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] })) });
    await provider.testAiProvider({ ...initial, apiKeyConfig: { baseUrl: 'https://edited.synthetic.invalid/v1', model: 'edited', apiKey: 'synthetic-unsaved-key', headers: [{ name: 'x-opencode-session', value: '{session_id}' }, { name: 'x-static', value: 'synthetic-static' }, { name: '__proto__', value: 'synthetic-proto' }] } });
    expect(settings.read()).toEqual(initial);
    const [url, init] = deps.fetchFn.mock.calls[0];
    expect(url).toBe('https://edited.synthetic.invalid/v1/chat/completions');
    expect(init.headers['x-static']).toBe('synthetic-static');
    expect(init.headers['__proto__']).toBe('synthetic-proto');
    expect(Object.getPrototypeOf(init.headers)).toBeNull();
    expect(init.headers['x-opencode-session']).toMatch(/^[0-9a-f-]{36}$/);
    expect(init.headers.Authorization).toBe('Bearer synthetic-unsaved-key');
    expect(init.redirect).toBe('error');
  });
  it('shares a session within an explicit logical task/retry and creates distinct default tasks', async () => {
    const config = { ...initial, apiKeyConfig: { ...initial.apiKeyConfig, headers: [{ name: 'x-opencode-session', value: 'encrypted:{session_id}' }] } };
    const fetchFn = vi.fn().mockRejectedValueOnce(new Error('synthetic transient')).mockImplementation(async () => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const { provider } = factory({ initial: config, fetchFn });
    const taskContext = { sessionId: '12345678-1234-4234-8234-123456789abc' };
    await expect(provider.completeText([{ role: 'user', content: 'synthetic' }], { taskContext })).rejects.toThrow();
    await provider.completeText([{ role: 'user', content: 'synthetic retry' }], { taskContext });
    await provider.completeText([{ role: 'user', content: 'another task' }]);
    expect(fetchFn.mock.calls[0][1].headers['x-opencode-session']).toBe(taskContext.sessionId);
    expect(fetchFn.mock.calls[1][1].headers['x-opencode-session']).toBe(taskContext.sessionId);
    expect(fetchFn.mock.calls[2][1].headers['x-opencode-session']).not.toBe(taskContext.sessionId);
  });
  it('applies custom headers to streaming calls and keeps provider/network errors secret-free', async () => {
    const initialWithHeaders = { ...initial, apiKeyConfig: { ...initial.apiKeyConfig, headers: [{ name: 'x-private', value: 'encrypted:synthetic-private' }] } };
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { provider, deps } = factory({ initial: initialWithHeaders, fetchFn: vi.fn().mockResolvedValue(sseResponse([completionEvent('ok'), 'data: [DONE]\n\n'])) });
    expect(await collect(provider.streamChat([{ role: 'user', content: 'synthetic' }]))).toEqual(['ok']);
    expect(deps.fetchFn.mock.calls[0][1].headers['x-private']).toBe('synthetic-private');
    deps.fetchFn.mockResolvedValue(jsonResponse({ error: { message: 'echo synthetic-private synthetic-key' } }, 400));
    const err = await provider.testAiProvider().catch(e => e);
    expect(err.message).not.toContain('synthetic-private');expect(err.message).not.toContain('synthetic-key');
    deps.fetchFn.mockRejectedValue(new Error('encoded echo synthetic-private'));
    const network = await provider.completeText([]).catch(e => e);expect(network.message).not.toContain('synthetic-private');
    expect(errorLog).not.toHaveBeenCalled();errorLog.mockRestore();
  });
});
