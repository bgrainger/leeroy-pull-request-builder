"use strict";

var server = require('./dist/server');
server.start(process.env.PORT, 'https://git.faithlife.dev/api/v3', process.env.GITHUB_TOKEN);
