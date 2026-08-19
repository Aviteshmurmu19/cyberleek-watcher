# CYBERLEEK Watcher

Lightweight Node.js watcher that monitors the CYBERLEEK Solana program for new leak accounts and sends Discord notifications. Designed for Render Free tier deployment.

## How it works

CYBERLEEK publishes leak data as on-chain Solana accounts under program `7rAgHPLDc9NryZmNdeEzyDui6D9PHkvTxMjKhNSa7w3a`. Each new leak creates a new content account. This watcher polls those accounts, diffs them against stored state, and alerts via Discord webhook when new content appears.

### Data path

- RPC: `getProgramAccounts` with `memcmp` + `dataSize` filters
- Encoding: `base64`
- Account size: `7156` bytes
- Poll interval: `60` seconds
- Response size: ~`76 KB` per poll

### Account binary layout

- Bytes `0..7`: discriminator (skip)
- Bytes `8..39`: authority pubkey
- Bytes `40..47`: `i64 LE` timestamp (Unix seconds)
- Bytes `48..51`: `u32 LE` title length
- Bytes `52..`: UTF-8 title
- Then: `u32 LE` item count, followed by `{ label, url }` pairs

## Project structure

```text
src/
├── config.js       # Environment variables & defaults
├── logger.js       # Pino logger
├── decoder.js      # Binary account buffer parser
├── fetcher.js      # Solana RPC getProgramAccounts client
├── store.js        # Upstash Redis + local file fallback
├── engine.js       # Bootstrap & diff detection
├── notifier.js     # Discord webhook embed sender
└── index.js        # Main orchestrator

test/
├── verify-fetch.js
├── verify-engine.js
├── verify-run.js
└── test-discord.js
```

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` with your secrets.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana RPC endpoint |
| `DISCORD_WEBHOOK_URL` | `''` | Discord webhook for alerts |
| `UPSTASH_REDIS_REST_URL` | `''` | Upstash Redis URL (optional) |
| `UPSTASH_REDIS_REST_TOKEN` | `''` | Upstash Redis token (optional) |
| `STATE_KEY` | `cyberleek:state` | Redis state key |
| `LOCAL_STATE_PATH` | `./data/state.json` | Local fallback state file |
| `LOG_LEVEL` | `info` | Pino log level |

State persistence:
- If `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set, uses Upstash Redis.
- Otherwise falls back to `LOCAL_STATE_PATH` on the local filesystem.

## Usage

```bash
npm start
```

First run bootstraps state from all current on-chain accounts without sending alerts. Subsequent runs only notify for new accounts.

## Testing

```bash
npm test
```

Runs:
- `verify-fetch.js` — live fetch + decode from mainnet
- `verify-engine.js` — bootstrap, duplicate detection, mock new account, local store round-trip
- `verify-run.js` — end-to-end lifecycle: bootstrap then no-op

Live Discord webhook test:
```bash
node test/test-discord.js
```

## Deployment

Recommended: Render Free **Cron Job**.

- Schedule: `*/1 * * * *` (every 1 minute)
- Set `DISCORD_WEBHOOK_URL` and `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` in Render env vars
- Command: `npm start`

Why cron over web service: no sleep, no cold starts, no UptimeRobot dependency.

## Caveats

- Render Free tier outbound bandwidth limit: `5 GB/month`. At 1-minute polling this uses ~`3.2 GB/month`.
- SMTP is blocked on Render Free; this project uses Discord webhook over HTTPS.
- Solana Labs public RPC limits: `100 req/10s` per IP, `40 req/10s` per method. At `1 req/60s` this is well within limits.
- Render Free cron pricing may vary. Verify in the Render dashboard before production.
