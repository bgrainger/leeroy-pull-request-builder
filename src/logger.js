const bunyan = require('bunyan');

let logger = bunyan.createLogger({
	name: 'LPRB',
	streams: [
		{
			stream: process.stdout,
			level: "debug"
		}
	] });

module.exports = logger;
