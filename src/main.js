require('babel/register');

if (!process.env.GITHUB_TOKEN) {
	log.error('GITHUB_TOKEN must be set;')
	process.exit(1);
}

// ignore errors for git's SSL certificate 
process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;

var server = require('./server');
server.start(process.env.PORT);
