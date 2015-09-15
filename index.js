"use strict";

// ignore errors for git's SSL certificate 
process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;

var server = require('./dist/server');
server.start(process.env.PORT, 'https://git/api/v3', process.env.GITHUB_TOKEN);
