'use strict';

if (require.main === module) {
  require('./bin/server.js');
} else {
  module.exports = require('./lib');
}
