const bunyan = require('bunyan');

let logger = bunyan.createLogger({
	name: 'LPRB',
	streams: [
		{
			stream: process.stdout,
			level: "debug"
		},
		{
			stream: process.stderr,
			level: "error"
		}
	] });

module.exports = logger;
