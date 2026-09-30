const fs = require('fs');
const path = require('path');
const https = require('https');

const { createLogService } = require('./logService');
const { logPort, parseInterval } = require('./config');

// Data and update cycle: logService.js. Logs are read from ../shared.
const service = createLogService(path.join(__dirname, '../shared'));

// Create HTTPS server to serve map contents
const server = https.createServer(
  {
    key: fs.readFileSync("/home/ubuntu/shared/server.key"),
    cert: fs.readFileSync("/home/ubuntu/shared/server.cert"),
  },
  (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const { statusCode, body } = service.respond(req.url);
    res.statusCode = statusCode;
    res.end(body);
});

server.listen(logPort, () => {
    console.log("----------------------------------------------------------------------------------------------------------------");
    console.log("----------------------------------------------------------------------------------------------------------------");
    console.log(`HTTPS logs server running at https://localhost:${logPort}`);
});

(async () => {
    await service.initialize();
    setInterval(() => service.tick(), parseInterval);
})();
