#!/usr/bin/env node
'use strict';

var bodyParser = require('body-parser');
var bunyan = require('bunyan');
var express = require('express');
var octokat = require('octokat');
var superagent = require('superagent-promise')(require('superagent'), Promise);

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
    if (req.body.action === 'opened' || req.body.action === 'reopened' || req.body.action === 'synchronize') {
      processPullRequest(req.body.pull_request)
        .then(null, function (e) {
          log.error(e);
          setErrorStatus(req.body.pull_request);
        });
      res.status(204).send();
    }    
  } else {
    res.status(400).send();
  }
});

app.post('/jenkins', function (req, res) {
  if (req.body && req.body.build) {
    var pr = activeBuilds[req.body.build.parameters.sha1];
    if (pr) {
      switch (req.body.build.phase) {
        case 'STARTED':
          setStatus(pr.base.repo.owner.login, pr.base.repo.name, pr.head.sha, 'pending', 'Building with Jenkins', req.body.build.full_url);
          break;
        case 'COMPLETED':
          setStatus(pr.base.repo.owner.login, pr.base.repo.name, pr.head.sha,
            req.body.build.status == 'SUCCESS' ? 'success' : 'failure',
            'Jenkins build status: ' + req.body.build.status,
            req.body.build.full_url);
          break;
      }
    }
    res.status(204).send();    
  } else {
    res.status(400).send();
  }
});

app.listen(3000);

function processPullRequest(pr) {
  var baseUser = pr.base.repo.owner.login;
  var baseRepo = pr.base.repo.name;
  var baseBranch = pr.base.ref;
  var prSha = pr.head.sha;
  return leeroyBranches.then(function (lb) {
    var key = baseUser + '/' + baseRepo + '/' + baseBranch;
    log.info('Received pull_request event for ' + key + ': SHA = ' + prSha);
    if (lb[key]) {
      return setStatus(baseUser, baseRepo, prSha, 'pending', 'Preparing build')
        .then(function () {
          return Promise.all(lb[key].map(function (config) {
            var buildUserRepo = config.repoUrl.match(buildRepoUrl);
            var buildRepo = github.repos(buildUserRepo[1], buildUserRepo[2]);
            return buildRepo.git.refs('heads', config.branch).fetch()
              .then(function (ref) {
                log.info('Repo ' + config.repoUrl + ' is at commit ' + ref.object.sha);
                return buildRepo.git.commits(ref.object.sha).fetch();
              })
              .then(function (commit) {
                return buildRepo.git.trees(commit.tree.sha).fetch()
                  .then(function (tree) {
                    log.info('Commit ' + commit.sha + ' has tree ' + tree.sha);
                    var newItems = tree.tree.filter(function (treeItem) {
                      if (treeItem.mode === '160000' && treeItem.path == baseRepo) {
                        treeItem.sha = prSha;
                        return true;
                      }
                      return false;
                    });
                    var gitmodulesItem = tree.tree.filter(function (treeItem) {
                      return treeItem.path === '.gitmodules';
                    })[0];
                    return buildRepo.git.blobs(gitmodulesItem.sha).fetch()
                      .then(function (blob) {
                        var gitmodules = new Buffer(blob.content, 'base64').toString('utf-8')
                          .replace('git@git:' + baseUser + '/' + baseRepo + '.git', 'git@git:' + pr.head.repo.owner.login + '/' + pr.head.repo.name + '.git');
                        return buildRepo.git.blobs.create({
                          content: gitmodules
                        })
                          .then(function (newBlob) {
                            log.info('newBlob.sha = ' + newBlob.sha);
                            gitmodulesItem.sha = newBlob.sha;
                            newItems.push(gitmodulesItem);
                            return buildRepo.git.trees.create({
                              base_tree: tree.sha,
                              tree: newItems
                            });
                          })
                      });
                })
                .then(function (newTree) {
                  log.info('newTree = ' + newTree.sha);
                  return buildRepo.git.commits.create({
                    message: 'PR test commit',
                    tree: newTree.sha,
                    parents: [ commit.sha ]
                  });
                });
              })
              .then(function (newCommit) {
                log.info('New commit is ' + newCommit.sha + '; updating ref.');
                var refName = 'heads/lprb';
                return buildRepo.git.refs(refName).fetch()
                  .then(function () {
                    return buildRepo.git.refs(refName).update({
                      sha: newCommit.sha,
                      force: true
                    });
                  }, function() {
                    return buildRepo.git.refs.create({
                      ref: 'refs/' + refName,
                      sha: newCommit.sha
                    });                  
                })
                .then(function() {
                  activeBuilds[newCommit.sha] = pr;
                  return Promise.all(config.pullRequestBuildUrls.map(function (prBuildUrl) {
                    log.info('Starting a build at ' + prBuildUrl);
                    return superagent
                      .get(prBuildUrl)
                      .query({ sha1: newCommit.sha });
                  }));
                });
              });
          }));
        });
      // create a new one with an updated submodule
      // 
    }
  });
}

function setStatus(user, repo, sha, state, description, targetUrl) {
  return github.repos(user, repo).statuses(sha).create({
    state: state,
    description: description,
    target_url: targetUrl,
    context: 'leeroy-pull-request-builder'
  });
}

function setErrorStatus(pr) {
  return setStatus(pr.base.repo.owner.login, pr.base.repo.name, pr.head.sha, 'error', 'Error creating CI build');
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
        return f && !f.disabled && f.submodules && f.pullRequestBuildUrls && buildRepoUrl.test(f.repoUrl);
      });
      log.info('there are ' + enabledFiles.length + ' enabled files with submodules and PR build URLs.');
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

var leeroyBranches = getLeeroyBranches();
var activeBuilds = {};
var buildRepoUrl = /^git@git:([^/]+)\/([^.]+).git$/;