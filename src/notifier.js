const config = require('./config');
const logger = require('./logger');

async function sendDiscordAlert(account, webhookUrl = config.DISCORD_WEBHOOK_URL) {
  if (!webhookUrl) {
    logger.warn({ pubkey: account.pubkey }, 'No DISCORD_WEBHOOK_URL configured, skipping alert');
    return { success: false, skipped: true };
  }

  const embed = {
    title: `🚨 New CYBERLEEK: ${account.title}`,
    color: 0x0064EC,
    timestamp: new Date(account.timestamp * 1000).toISOString(),
    fields: [
      { name: 'Solana Account', value: `\`${account.pubkey}\``, inline: false },
      {
        name: `Mirrors (${account.items.length})`,
        value: account.items.map(i => `• [${i.label}](${i.url})`).join('\n') || 'None',
        inline: false,
      },
    ],
    footer: { text: 'CYBERLEEK Watcher' },
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error({ status: res.status, body: text, pubkey: account.pubkey }, 'Discord webhook failed');
      return { success: false, skipped: false, error: `HTTP ${res.status}` };
    }

    logger.info({ pubkey: account.pubkey, title: account.title }, 'Discord alert sent');
    return { success: true };
  } catch (err) {
    logger.error({ error: err.message, pubkey: account.pubkey }, 'Discord webhook error');
    return { success: false, skipped: false, error: err.message };
  }
}

module.exports = { sendDiscordAlert };
