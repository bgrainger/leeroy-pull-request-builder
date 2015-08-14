#!/usr/bin/env node
'use strict';

var bodyParser = require('body-parser');
var bunyan = require('bunyan');
var express = require('express');
var octokat = require('octokat');

// ignore errors for git's SSL certificate 
process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;

var log = bunyan.createLogger({ name: 'app' });
var app = express();
app.use(bodyParser.json());
var github = new octokat({
  token: process.env.GITHUB_TOKEN,
  rootURL: 'https://git/api/v3'
})

log.info('Starting');

app.get('/',  function (req, res) {
  res.send('leeroy-pull-request-builder');
});

app.post('/event_handler', function (req, res) {
  var gitHubEvent = req.headers['x-github-event'];
  log.info('Received event: ' + gitHubEvent);
  if (gitHubEvent === 'ping') {
    res.status(204).send();
  } else if (gitHubEvent === 'pull_request') {
    process_pull_request(req.body.pull_request)
      .then(function() {
        res.status(204).send();
      }, function (e) {
        log.error(e);
        res.status(500).send();
      })
  } else {
    res.status(400).send();
  }
});

app.listen(3000);

function process_pull_request(pr) {
  return github.repos(pr.base.repo.owner.login, pr.base.repo.name).statuses(pr.head.sha).create({
    state: 'pending',
    description: 'Waiting for build to start',
    context: 'leeroy-pull-request-builder'
  })
  .then(function (x) {
    log.info(x);
  });
}

function getLeeroyBranches() {
  return github.repos('Build', 'Configuration').contents.fetch()
    .then(function (contents) {
      log.info('Contents has ' + contents.length + ' files');
      var jsonFiles = contents.filter(function (elem) {
        return elem.path.indexOf('.json') === elem.path.length - 5;
      });
      return Promise.all(jsonFiles.map(function (elem) {
        return github.repos('Build', 'Configuration').contents(elem.path).read()
          .then(function (contents) {
            try {
              return JSON.parse(contents);
            }
            catch (e) {
              return null;
            }
          });
      }));
    })
    .then(function (files) {
      var enabledFiles = files.filter(function (f) {
        return f && !f.disabled && f.submodules;
      });
      log.info('there are ' + enabledFiles.length + ' enabled files with submodules.');
      var repos = { };
      enabledFiles.forEach(function (file) {
        for (var submodule in file.submodules) {
          var key = submodule + '/' + file.submodules[submodule];
          repos[key] = repos[key] || [];
          repos[key].push(file);
        }
      });
      return repos;
    })
    .then(null, function(err) {
      log.error(err);
    });
}

// getLeeroyBranches();