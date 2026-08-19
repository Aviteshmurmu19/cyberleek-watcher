const http = require('http');
const config = require('./config');
const logger = require('./logger');
const { runWatcher } = require('./index');

function createServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if ((req.method === 'GET' && url.pathname === '/') || (req.method === 'GET' && url.pathname === '/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'cyberleek-watcher' }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/check') {
      try {
        const result = await runWatcher();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        logger.error(err, 'Check endpoint failed');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: err.message }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'not found' }));
  });

  return server;
}

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const server = createServer();
  server.listen(PORT, '0.0.0.0', () => {
    logger.info({ port: PORT }, 'Cyberleek Watcher HTTP server listening');
  });
}

module.exports = { createServer };
