# Search and desktop Inbox fork

Repository: https://github.com/shady2k/mailflow.git
Branch: `feat/unicode-body-search-and-inbox-layout`.
Base: upstream/fork main `4f6a659fd10927f3bd36a68b3c2c78b933108874` (3.9.0).
No push, PR, production deployment or real mail credentials are part of this work.

## Search

Migrations 0066/0067 add explicit Unicode folding, expression trigram indexes and a durable full-body queue. Russian and English substring searches are case independent, including under PostgreSQL C locale. ICU is used when available; the fallback explicitly translates Cyrillic uppercase letters, including Ё. Other alphabets depend on PostgreSQL's fallback lower-case behavior. There is no English stemming or body truncation.

The worker claims at most two messages globally, one per enabled IMAP account, with persisted ten-minute leases. Transient failures retry from one minute up to one hour; restarts resume expired leases. Provider cooldowns and active foreground work pause fetches. Complete body text is downloaded once even for previously cached messages, because old rendering caches can omit MIME sections. All ordinary plain/HTML text sections are indexed; missing sections retry, zero-length sections are valid. Script/style/head content is excluded, no remote HTML URLs are fetched, and attachments are not indexed.

Coverage is **loaded headers**, not a promise that every provider message has been synchronized. `/api/search/index-status` and account settings report pending/error counts per account. Full bodies remain additional database/disk/network work; trigram indexes can be large. Concurrent index creation avoids blocking normal writes. Text changes invalidate completed coverage.

Gmail All Mail is included so archived messages can appear. Folder filters apply before deduplication. Same-account copies with matching Message-ID, verified full text, subject/from/date are paired across folder views; repeated deliveries within a folder retain their multiplicity. Different bodies and different accounts remain separate. This is conservative content equivalence, not Gmail's provider-certified X-GM-MSGID identity; equivalent copies with different metadata may appear twice.

## Desktop Inbox

The opt-in Inbox layout uses the full list width, dense sender/subject/snippet/date rows, checkboxes and stars. Opening a row shows the reader; the back button and browser history restore the list. The list remains mounted, preserving its query, loaded rows and scroll during the normal list→reader→back path. Keyboard next/previous replaces the reader history entry. Category/page and store filters are captured; restoration waits for loading to settle. Other desktop presets and the mobile branch retain their existing layouts.

Browser history across older, independently reloaded infinite-scroll contexts may restore only the currently available rows; it does not serialize arbitrary loaded-page datasets. React/jsdom tests cover mounted panels, history, focus, scroll and checkbox/star propagation. Headless Chromium 143 at 1440×1000 additionally verified the real built UI: full-width list, body-token search, row open/back, browser Back/Forward preserving query and checkbox behavior, without JavaScript page errors. Screenshots and logs are saved alongside the repository in `../mailflow-validation`. Cross-context infinite-scroll restoration remains a limitation.

## Verification / local synthetic lab

Use Node 22, `npm ci` in backend and frontend, then their lint/test scripts and `npm --prefix frontend run build`. On macOS, existing shortcut fixtures assume Linux; run frontend tests with the optional preload:

```sh
cd frontend
NODE_OPTIONS="--import=../scripts/test-frontend-ci-platform.mjs" npm test
```

The separate PostgreSQL matrix is internal-only, ephemeral and uses public synthetic credentials:

```sh
docker compose -f contrib/compose.search-tests.yaml up -d pg16 pg18
docker compose -f contrib/compose.search-tests.yaml run --rm test16
docker compose -f contrib/compose.search-tests.yaml run --rm -e SEARCH_TEST_NO_ICU=1 test16
docker compose -f contrib/compose.search-tests.yaml run --rm test18
docker compose -f contrib/compose.search-tests.yaml down
```

The existing isolated lab is `/Users/shady/Documents/Codex/2026-10-11/task/mailflow-lab`, project `mailflow-synthetic-lab`. Developer overlay uses the pinned official runtime/dependencies and this fork's source; frontend needs a build. Start only on localhost:

```sh
export MAILFLOW_FORK_ROOT=/Users/shady/Documents/Codex/2026-10-11/task/mailflow-fork
docker compose -f ../mailflow-lab/compose.localhost.yaml -f contrib/compose.lab-dev.yaml up -d --pull never
```

URL: http://localhost:18089 (on Mac mini). Login `demo` / `DemoMail123!` is deliberately public test data; alice/bob@lab.test are internal synthetic boxes. This developer overlay does not publish a LAN listener. Database and GreenMail have no host ports or external mail relay. `scripts/verify-search-lab.mjs` refuses a non-localhost/non-synthetic environment and tests unopened plain/HTML/archive/second-MIME-part bodies, RU/EN folding and account/folder filters.

Stop without deleting synthetic data:

```sh
docker compose -f ../mailflow-lab/compose.localhost.yaml stop
```

GreenMail's in-memory messages disappear on stop. Recreate the synthetic fixtures after starting with `docker compose -f ../mailflow-lab/compose.localhost.yaml exec -T backend node /tests/verify-search-lab.mjs`. Database volumes are retained. Existing plMail, Kubernetes and real accounts are untouched. Calendar/AI workflows and a full synchronization redesign are outside scope.

## Recorded results

On Node 22: backend 2431 passed, 33 upstream conditional skips; frontend 2826 passed using the CI-platform preload. Both lint suites, plugin boundary lint and frontend build passed. Existing build chunk-size warnings remain. PostgreSQL 16.15 and 18.6 (C locale), plus forced no-ICU fallback: six integration cases passed on each. Real GreenMail IMAP/SMTP: four unopened full-body cases passed, including the second MIME part; all four remained searchable after backend restart, with 13/13 loaded headers indexed. Production-only npm audit has no high/critical findings; inherited moderate qs/react-router advisories remain. The lab is stopped after validation; its volumes are retained.

UI correction: indexing coverage is shown only in account settings (including per-account edit, pending/errors and read-only refresh). Mail views poll silently to keep search results current. Inbox snippets use a separate muted line below the subject; empty or disabled previews add no line. Synthetic Chromium desktop/mobile checks and all 2833 frontend tests passed.
