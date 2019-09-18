"use strict";

// ignore errors for Jenkins' SSL certificate 
process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;

var server = require('./dist/server');
server.start(process.env.PORT, 'https://git.faithlife.dev/api/v3', process.env.GITHUB_TOKEN, process.env.JENKINS_USER, process.env.JENKINS_TOKEN);
