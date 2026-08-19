# Cyberleek Watcher — Agent Context

## Project Goal
Build a lightweight Node.js watcher that polls the CYBERLEEK website's on-chain data source, detects new leaks, and sends notifications via Discord webhook. Deployed on **Render Free Web Service + cron-job.org** for a 100% free ($0/mo) 24/7 operation.

---

## Data Source

### What CYBERLEEK Is
Static HTML/JS site at `https://cyberleek.ar.io/`. No backend server. All dynamic data comes directly from Solana mainnet on-chain accounts.

### How the Data Is Fetched
- **Method**: `getProgramAccounts` JSON-RPC 2.0 over HTTPS
- **Program ID**: `7rAgHPLDc9NryZmNdeEzyDui6D9PHkvTxMjKhNSa7w3a`
- **Filters**: `memcmp { offset: 0, bytes: "G6JNBZ2BSey" }` + `dataSize: 7156`
- **Encoding**: `base64`
- **Endpoint**: `https://api.mainnet-beta.solana.com` (Solana Labs public RPC)
- **Response Time**: ~800–1000ms wall-clock
- **Response Size**: ~76 KB per poll

### Account Binary Layout (7156 bytes)
- Bytes `0..7`: Discriminator (skip)
- Bytes `8..39`: Authority pubkey (32 bytes)
- Bytes `40..47`: Timestamp `i64 LE` (Unix seconds)
- Bytes `48..51`: `u32 LE` title length
- Bytes `52..(52+titleLen)`: UTF-8 string title
- Next 4 bytes: `u32 LE` item count
- Then: `u32 LE` label length → UTF-8 label → `u32 LE` url length → UTF-8 url

### Accounts Inventory
Each account = one discrete leak. Titles can repeat (e.g. duplicate "GTA 6: map sneak peek 1" exists as two separate accounts created 9 minutes apart). **Stable unique ID = Solana account pubkey**.

---

## Key Architectural Findings

### Event Model
- Each new leak creates a **brand-new Solana account** (new pubkey).
- Existing accounts are immutable and never modified after creation.
- "Updates" to existing leaks = new accounts with higher creation timestamps.
- Authority never reuses pubkeys.

### State Schema (Hybrid: seenPubkeys + lastMaxTimestamp)
```json
{
  "initialized": true,
  "seenPubkeys": [
    "2XRc2NJhXkcFNBzWeMkbGunBMLLKRjdEkV9aBWZQ1oww",
    "D2KikcD6xrTezwXDhNzm6Y8dEbG4g8x2m85AKr912Tqc"
  ],
  "lastMaxTimestamp": 1787158475,
  "updatedAt": "2026-08-20T01:00:00.000Z"
}
```
- `seenPubkeys`: Array of all account pubkeys seen. Guarantees exact duplicate suppression.
- `lastMaxTimestamp`: Maximum creation timestamp seen so far. Preserves monotonic ordering.
- `updatedAt`: ISO-8601 timestamp of last state mutation.

### State Persistence
- **Render Filesystem is Ephemeral**: Local state is wiped on container restarts/redeployments.
- **Primary Store**: **Upstash Redis** via REST API (`@upstash/redis`) — persistent, free (256 MB, 500K commands/month), zero TCP connection pool overhead.
- **Local Fallback**: `data/state.json` for offline testing and local development.

### Bootstrap Algorithm (Silent Baseline Initialization)
1. On cold start with no prior state in Upstash:
   - Queries `getProgramAccounts`.
   - Records all current on-chain pubkeys into `seenPubkeys` and highest timestamp into `lastMaxTimestamp`.
   - Saves state and exits **without sending any Discord notifications**.
2. On subsequent runs:
   - Diffs current accounts against `seenPubkeys`.
   - For any account whose `pubkey` is not in `seenPubkeys`:
     - Dispatches rich embed alert to Discord webhook.
     - Adds `pubkey` to `seenPubkeys` and updates `lastMaxTimestamp`.
     - Persists updated state to Upstash Redis.

---

## Production Deployment Architecture

### Final Architecture: Render Free Web Service + cron-job.org
- **Why not Render Cron Jobs?** Render Cron Jobs require a paid instance plan (minimum billing); there is no $0/mo Free tier for Render Cron.
- **Why not Render Web Service + UptimeRobot?** UptimeRobot free tier is limited to 5-minute intervals. A 60-second internal `setInterval` loop dies whenever Render restarts or spins down the container.
- **Why Render Free Web Service + cron-job.org Wins:**
  1. **Zero Spindown / Zero Cold Starts**: `cron-job.org` pings `GET /check` every 1 minute, constantly resetting Render's 15-minute inactivity timer.
  2. **Direct Execution Model**: Each 1-minute ping directly executes `runWatcher()` and returns the execution JSON. No detached, fragile background daemon.
  3. **100% Free**: Operates entirely within free tiers ($0.00/month).

### Endpoints
- `GET /health` or `GET /`: Returns `{"status": "ok", "service": "cyberleek-watcher"}` (`200 OK`).
- `GET /check`: Runs fetch → decode → diff → notify → store and returns execution summary JSON.

---

## File Inventory

| File | Purpose |
|---|---|
| `index.js` | Root entry point that boots `startServer()` for Render default start command |
| `src/server.js` | Native Node.js HTTP server exposing `/health` and `/check` |
| `src/index.js` | Core orchestrator (`runWatcher()`) and CLI runner (`main()`) |
| `src/config.js` | Environment configuration with `dotenv` support and frozen defaults |
| `src/logger.js` | Structured `pino` logger instance |
| `src/decoder.js` | Binary buffer parser for 7156-byte Solana leak accounts |
| `src/fetcher.js` | Solana JSON-RPC `getProgramAccounts` client with PDA & size filters |
| `src/store.js` | Storage adapter: Upstash Redis REST with local file fallback |
| `src/engine.js` | Pure function diff engine with bootstrap & new-account detection |
| `src/notifier.js` | Discord webhook dispatcher with rich embed formatting |
| `test/verify-fetch.js` | Live Solana mainnet account query and decoding test |
| `test/verify-engine.js` | Unit tests for bootstrap, rerun no-op, mock diff, and store round-trip |
| `test/verify-run.js` | End-to-end lifecycle verification test (bootstrap → no-op) |
| `test/verify-server.js` | HTTP endpoint verification test (`/health`, `/check`, `/`) |
| `test/test-discord.js` | Live Discord test embed dispatcher |
| `.env.example` | Template for environment variables |
| `package.json` | Project configuration and scripts |

---

## Commands

```bash
# Run all 4 test suites
npm test

# Run single manual check via CLI
npm run check:once

# Run HTTP server locally
npm start

# Test Discord alert delivery
node test/test-discord.js
```

---

## Operational Verification
- **Discord Alerts**: Verified with rich embed containing title, pubkey, timestamp, and mirror links.
- **Upstash State**: Verified with live cloud read/write.
- **cron-job.org**: Verified with live `200 OK` responses in <1 second execution time.
