
const { startApiServer } = require('./api');
startApiServer();

const { startBot } = require('./bot');
startBot();

const { processDMQueue } = require('./dmQueue');
