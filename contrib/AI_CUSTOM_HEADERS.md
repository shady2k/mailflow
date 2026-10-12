# Additional AI HTTP headers

Settings → AI assistant → API-key connection now has a Header / Value table, an initially empty row, add/remove controls and an unsaved-form connection test. This applies to the configured OpenAI-compatible API-key provider; ChatGPT device/OAuth transport does not receive those custom headers.

Example: header `x-opencode-session`, value `{session_id}`. Literal values are supported. Only this substitution is interpreted; there is no script/template execution.

## Task identity

Each `completeText` or `streamChat` task creates a random UUID. A caller performing several internal requests/retries for one logical task can pass the same `{ taskContext: { sessionId } }` option. Separate HTTP chat/test requests are separate tasks. API-key transport currently does not automatically retry failed HTTP calls; the context is nevertheless shared explicitly by callers that retry. A connection test is its own task and uses edited, unsaved base URL/model/key/headers without writing settings.

The GTD background summary path is a lazy best-effort batch, not a general durable job queue. Its pending UUID is atomically stored in the message's GTD annotation. Another worker or a reconstructed worker reuses that pending UUID; a saved gist blocks a stale worker from claiming another task. A successful gist write clears the pending UUID. If a new summary is requested after the cached gist is cleared, a new UUID is created. Failed requests keep the pending ID. This is not a permanent ID of an email and does not add exactly-once execution guarantees.

Compose, AI actions and interactive summary prompts use streaming `/ai/chat`; generic summaries/GTD use `completeText`; category classification also uses `completeText`. Both shared API transports construct the same protected headers.

## Storage and validation

All additional values use the existing API-key AES-256-GCM encryption helper/key. Admin GET and save responses return masked values, including a stored `{session_id}` template. An unchanged masked row preserves the existing encrypted value by canonical header name; changing a name requires entering a replacement value, except for case-only name edits. Removing a row explicitly deletes it. Completely blank UI rows are omitted; an empty name with a nonempty value is rejected.

Names must be HTTP tokens (at most 128 characters), are canonicalized to lowercase, and cannot duplicate case-insensitively. Values must be printable ASCII, at most 2048 characters; maximum 20 entries and 16 KiB total. Validation also runs after session substitution. Host, Content-Length, Content-Type, Accept, standard authentication/cookie headers, hop-by-hop headers and proxy-/sec- prefixes are protected. Transport uses a null-prototype header object, including for a legitimate `__proto__` header name.

Both API-key paths use `redirect: error`: no custom or authorization header is forwarded through redirects. Provider and network errors with custom headers return generic messages; values are never logged by configuration/provider routes. API-key credentials retain their existing masking behavior.

No SQL migration is needed: headers extend the existing optional `ai_config` JSON and pending GTD context extends existing plugin annotation JSON. Existing flat/structured configurations without headers remain valid. Keep the same encryption key; backups contain encrypted header values. An older version ignores the new fields, but saving settings with that older version can discard unsupported fields, so retain a configuration/database backup before rollback.

## Verification

Backend tests cover saved/encrypted/redacted reload, mask preservation/removal/rename policy, unsaved testing, UUID reuse and separation, invalid/reserved/duplicate/CRLF/limit cases, secret-free errors, and synthetic HTTP transport across streaming, summary and classification. PostgreSQL 16/18 tests use two connections to verify atomic pending ID creation, reconstructed workers, completion blocking, and new-task IDs. React/browser tests cover row controls, masking, unsaved test payload and desktop/mobile layout.

A previous synthetic mail lab already had an AI configuration; it was not overwritten or invoked. AI E2E tests use a separate **fresh** project, `mailflow-ai-headers-lab`, with public test-only credentials, disabled `@lab.test` mail accounts and an internal loopback mock provider. No real endpoint or key is used.

```sh
export MAILFLOW_FORK_ROOT=/Users/shady/Documents/Codex/2026-10-11/task/mailflow-fork
# Build frontend first. Fresh ephemeral DB; binds only localhost:18090.
docker compose -f contrib/compose.ai-headers-lab.yaml up -d --pull never
docker compose -f contrib/compose.ai-headers-lab.yaml exec -T backend node /tests/bootstrap-ai-lab.mjs
# Run the mock server in another terminal:
docker compose -f contrib/compose.ai-headers-lab.yaml exec -T backend node /tests/mock-ai-server.mjs
# Then:
docker compose -f contrib/compose.ai-headers-lab.yaml exec -T backend node /tests/verify-ai-lab.mjs
# Remove only this ephemeral fixture:
docker compose -f contrib/compose.ai-headers-lab.yaml down
```

Recorded final local checks: backend 2455 passed (33 existing conditional skips), frontend 2842 passed, lint/plugin-boundary/build passed, PostgreSQL 16/18 seven cases passed each. Actual fresh-lab API tests verified encrypted/redacted reload, unsaved connection testing and all shared entrypoints. Chromium verified desktop/mobile header editing and unsaved test without implicit save. Independent read-only security review found no remaining confirmed P1/P2 after the null-prototype-header and stale-worker fixes.
