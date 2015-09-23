const bunyan = require('bunyan');

export default bunyan.createLogger({
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
