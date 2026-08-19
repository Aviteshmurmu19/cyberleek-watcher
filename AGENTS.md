# Cyberleek Watcher — Agent Context

## Project Goal
Build a lightweight Node.js watcher that polls the CYBERLEEK website's on-chain data source, detects new/updated leaks, and sends notifications via Discord webhook. Deploy on Render Free tier.

## Data Source

### What CYBERLEEK Is
Static HTML/JS site at `https://cyberleek.ar.io/`. No backend server. All dynamic data comes from Solana mainnet on-chain accounts.

### How the Site Fetches Data
- **Method**: `getProgramAccounts` JSON-RPC 2.0 over HTTPS
- **Program ID**: `7rAgHPLDc9NryZmNdeEzyDui6D9PHkvTxMjKhNSa7w3a`
- **Filters**: `memcmp { offset: 0, bytes: "G6JNBZ2BSey" }` + `dataSize: 7156`
- **Encoding**: `base64`
- **Endpoint**: `https://api.mainnet-beta.solana.com` (Solana Labs public RPC)
- **Frequency**: Every 60 seconds via `setInterval(M, 6e4)`
- **Response time**: ~868ms wall-clock, ~76KB response

### Account Binary Layout (7156 bytes)
- Bytes 0-7: Discriminator (skip)
- Bytes 8-39: Authority pubkey (32 bytes)
- Bytes 40-47: Timestamp i64 little-endian (Unix seconds)
- Bytes 48+: Title (Borsh-style u32 length prefix + UTF-8)
- Then: Items vector (Borsh u32 count, then `{label: string, url: string}` pairs)

### Current Accounts (8 total, as of 2026-08-19)
Each account = one discrete leak. Title is not unique (duplicate "GTA 6: map sneak peek 1" exists twice with different pubkeys). Stable unique ID = Solana account pubkey.

## Key Findings

### Event Model
- Each new leak creates a **brand-new Solana account** (new pubkey)
- No existing account is ever modified after creation
- Timestamp is a creation timestamp, not "last modified"
- Authority never reuses pubkeys
- "Updates" to existing leaks = new accounts with higher timestamps

### State Schema (Hybrid: seenPubkeys + lastMaxTimestamp)
```json
{
  "initialized": true,
  "seenPubkeys": ["CXjLRA8w...", "9qjyztEy..."],
  "lastMaxTimestamp": 1787158475,
  "updatedAt": "2026-08-20T01:00:00.000Z"
}
```
- `seenPubkeys`: array of all account pubkeys ever seen. Enables exact duplicate detection.
- `lastMaxTimestamp`: maximum creation timestamp seen so far. Enables fast watermark checks and monotonic ordering.
- `updatedAt`: ISO-8601 timestamp of last state mutation.

**Why hybrid instead of timestamp-only:**
- The engine spec requires pubkey-level diffing for bootstrap safety.
- `seenPubkeys` guarantees no re-notification for already-known accounts across restarts.
- `lastMaxTimestamp` preserves monotonic ordering for future optimization.
- State size is still O(n) but bounded by total on-chain accounts (currently 8, very small).

### State Persistence
- **Cannot use local filesystem** (ephemeral on Render Free)
- **Use Upstash Redis** (free tier: 256 MB, 500K commands/month, HTTP REST API, no persistent disk needed)
- **Why not Render Key Value?** Free tier is in-memory only — data is lost on restart
- **Why not Render Postgres?** Free tier expires after 30 days
- Store: single JSON string under one key
- **Local fallback**: `data/state.json` for local development

### Initialization Algorithm (stateless startup)
```
1. Call getProgramAccounts(PROGRAM_ID, { encoding: 'base64', filters: [memcmp offset 0 bytes G6JNBZ2BSey, dataSize 7156] })
2. For each returned account: timestamp = read i64 LE from bytes 40-47
3. seenPubkeys = array of all account pubkeys
4. lastMaxTimestamp = max of all timestamps, or 0 if no accounts exist
5. Save state: { initialized: true, seenPubkeys, lastMaxTimestamp, updatedAt: ISO-8601 }
6. Do NOT send notifications for any of these accounts — they are the existing baseline
```

### Polling Algorithm (every 60 seconds)
```
1. Load state: { initialized, seenPubkeys, lastMaxTimestamp }
2. Call getProgramAccounts(PROGRAM_ID, { same filters })
3. seenSet = new Set(seenPubkeys)
4. newAccounts = currentAccounts.filter(acc => !seenSet.has(acc.pubkey))
5. If newAccounts not empty:
     For each: send Discord notification with decoded content
     updatedSeen = [...seenSet, ...newAccounts.map(a => a.pubkey)]
     updatedMaxTimestamp = max(lastMaxTimestamp, ...newAccounts.map(a => a.timestamp))
     Save state: { initialized: true, seenPubkeys: updatedSeen, lastMaxTimestamp: updatedMaxTimestamp, updatedAt: ISO-8601 }
   If empty: do nothing. State stays unchanged.
```

### Safety Guarantees
- **No false positives**: Bootstrap saves all current pubkeys; only pubkeys NOT in `seenPubkeys` trigger notification
- **No missed detections**: New accounts have new pubkeys; any account not in `seenPubkeys` is new
- **No duplicate notifications**: `seenPubkeys` grows monotonically; once a pubkey is added, it is never removed
- **Stateless wrt history**: State grows O(n) with number of accounts, but bounded by on-chain total (currently 8)
- **Resilient to RPC gaps**: If an account is missed in one poll, it reappears in the next with same pubkey; if it was already in `seenPubkeys`, it is silently skipped — it was already notified in a prior poll

### Notification Mechanism Comparison
| Mechanism | Works over HTTPS from Render Free | Requires paid service | Setup complexity | Recommended? |
|---|---|---|---|---|
| **Discord webhook** | ✅ Yes (port 443) | No | Low (1 URL) | ✅ **Yes** |
| Telegram Bot API | ✅ Yes (port 443) | No | Medium (token + chat ID) | ❌ Second choice |
| HTTP email APIs | ✅ Yes (port 443) | No (but free tiers have caps) | High (account, API key, domain verify) | ❌ Overkill |
| SMTP | ❌ Blocked (ports 25/465/587) | N/A | N/A | ❌ Blocked |

**Recommendation: Discord webhook.**
- Simplest: one URL copied from Discord channel settings
- Rich embeds for structured leak data (title, timestamp, URLs, color)
- No domain verification, no daily caps, no spam filters
- One secret to store in Render env vars

### WebSocket Subscription Investigation
Tested all four Solana WebSocket subscription types for detecting content account changes:

| Mechanism | Detects new accounts? | Needs known pubkey? | Authority-dependent? | Payload | Setup latency |
|---|---|---|---|---|---|
| `programSubscribe` + memcmp | ✅ Yes | ❌ No | ❌ No | Full 7156-byte account + pubkey | ~1.3s |
| `programSubscribe` + dataSize | ✅ Yes (all program accounts) | ❌ No | ❌ No | Full account data + pubkey | ~1.2s |
| `logsSubscribe` + mentions | ⚠️ Only tx signature | ❌ No | ❌ No | Log strings + signature only | ~1.4s |
| `accountSubscribe` | ❌ No (discovery) | ✅ Yes | ❌ No | Full account data | ~1.4s |

**Key findings:**
- **The authority is NOT the subscription target.** The PROGRAM ID is the target. The memcmp filter further narrows to content accounts only by binary discriminator at offset 0 and size 7156.
- **`programSubscribe` with memcmp filters** is the correct mechanism: it detects new accounts without referencing the authority, returns the full account data and new pubkey in the notification, and requires no follow-up RPC calls.
- **`logsSubscribe`** only returns transaction signatures and log strings — does not identify which account was created or modified.
- **`accountSubscribe`** is useless for discovery since new accounts have new pubkeys.
- **WebSocket is not viable on Render Free** anyway because dyno sleep kills the connection and cold-start blind spots negate the benefit.

## Deployment Architecture

### Recommended: Render Free Cron Job
- **Service type**: Cron job (not web service, not background worker)
- **Schedule**: `*/1 * * * *` (every 1 minute)
- **Why cron over web service**: No sleep, no cold starts, no UptimeRobot dependency
- **Render Free tier limits**:
  - 750 hours/month
  - 5 GB outbound bandwidth/month (new Hobby plan, April 2026)
  - No persistent disk (state must be external)
  - SMTP ports 25/465/587 blocked

### Resource Usage (measured)
- Per poll: ~1s execution, ~76KB bandwidth
- At 1-min interval: 43,200 req/month, 3.2 GB bandwidth, 11.7 hours execution
- All within Render Free limits

### Web Service + UptimeRobot Architecture Assessment
- **Not recommended** for a reliable 60-second polling loop
- Render Free spindown behavior (verified):
  - **Spindown trigger**: 15 minutes with **no inbound traffic** (HTTP requests or WebSocket messages from existing connections)
  - **SIGTERM + grace period**: Render sends SIGTERM, gives 30s grace, then SIGKILL if still running
  - **Cold start**: ~30–60s when next request arrives
  - **Restart risk**: Render docs state free services "might restart at any time"
  - **Outbound traffic does NOT count as inbound**: Internal polling to Solana RPC does not reset the idle timer
  - **Render health checks do NOT count** toward preventing spindown
  - **`/robots.txt` special case**: Returns auto-generated "disallow all" while spun down and does NOT wake the service
  - **`/health` endpoint behavior**: A request to `/health` wakes a spun-down service and resets the 15-minute timer, but does NOT guarantee a background watcher stays alive afterward
- A `/health` ping wakes the service and keeps it awake for ~15 minutes, but:
  - Any ping gap >15 minutes kills the process
  - Every cold start introduces a 30–60s blind spot where no polls occur
  - Render can restart the service at any time
  - Watcher can die silently if `/health` is shallow and does not validate watcher state
- **If used anyway**: health endpoint should validate watcher freshness (e.g., `lastPollAt` timestamp), not just return 200

## Technical Constraints Verified

| Constraint | Status | Detail |
|---|---|---|
| CORS | N/A | Server-side Node.js, CORS irrelevant |
| Cookies | Not needed | Stateless RPC call |
| localStorage | Not needed | No browser state |
| Wallet state | Not needed | Read-only query |
| Browser headers | Not needed | Only `Content-Type: application/json` |
| Signed requests | Not needed | Public RPC, no auth |
| API key | Not needed for Solana Labs endpoint | Tatum requires key, not used |
| WebSocket | Not viable on Render Free | Outbound WS does not reset idle timer; dyno sleep kills connection; cold-start blind spot negates benefit; Render staff confirm SIGTERM+SIGKILL on spindown |

## File Inventory

| File | Purpose |
|---|---|
| `src/config.js` | Environment variables & default constants, dotenv wired in |
| `src/logger.js` | Pino logger instance |
| `src/decoder.js` | Binary account buffer parser |
| `src/fetcher.js` | Solana RPC getProgramAccounts client |
| `src/store.js` | Upstash Redis + local file fallback storage adapter |
| `src/engine.js` | Bootstrap & diff detection logic |
| `src/notifier.js` | Discord webhook embed formatter & sender |
| `src/index.js` | Main orchestrator / entry point |
| `test/verify-fetch.js` | Fetches & decodes all accounts from mainnet |
| `test/verify-engine.js` | Unit/integration tests for diffing & state persistence |
| `test/verify-run.js` | End-to-end lifecycle verification |
| `test/test-discord.js` | Live Discord webhook delivery test |
| `README.md` | Project documentation |
| `.env.example` | Documented environment variables |
| `.env` | Live secrets (Upstash + Discord) — gitignored |
| `.gitignore` | Excludes node_modules, .env, data, logs, investigation artifacts |
| `package.json` | Project config (name: `cyberleek-fetcher`) |
| `node_modules/` | Dependencies: `ws`, `pino`, `@upstash/redis`, `dotenv` |

## Important Caveats

1. **Render Free tier cron pricing**: Sources conflict. Render docs say $1/month minimum per cron job. Third-party sources say "unlimited free cron" on Hobby. Verify in dashboard before production.
2. **PublicNode ToS**: Broad language; can terminate access anytime. Use Solana Labs endpoint (`api.mainnet-beta.solana.com`) as primary.
3. **Rate limits**: Solana Labs public endpoint: 100 req/10s per IP, 40 req/10s per method. At 1 req/60s, well within limits.
4. **No persistent disk**: All state must be in external store. `/tmp` is lost on restart.
5. **Bandwidth**: 3.2 GB/month at 1-min polling. Under 5 GB limit but not by much.
6. **Monthly suspension**: If Free instance hours or bandwidth are exhausted, Render can suspend services until next month or until billing is added.
7. **Render health checks**: Do NOT count as inbound traffic for free-tier spindown prevention. Only real HTTP requests or WebSocket messages from existing connections reset the 15-minute idle timer.

## Commands

```bash
# Run all tests (fetch, engine, e2e)
npm test

# Run individual tests
node test/verify-fetch.js
node test/verify-engine.js
node test/verify-run.js

# Start the watcher (requires DISCORD_WEBHOOK_URL or Upstash env vars for production)
npm start
```

## Next Steps
1. Deploy as Render cron job
2. Verify cron pricing in Render dashboard
3. Add retry logic for RPC failures (exponential backoff)
4. Add integration test with mocked Upstash Redis for CI
