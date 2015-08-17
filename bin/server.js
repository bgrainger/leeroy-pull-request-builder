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
  log.info('Received GitHub event: ' + gitHubEvent);
  if (gitHubEvent === 'ping') {
    res.status(204).send();
  } else if (gitHubEvent === 'pull_request') {
    if (req.body.action === 'opened' || req.body.action === 'reopened' || req.body.action === 'synchronize') {
      var pr = req.body.pull_request;
      processPullRequest(pr)
        .then(null, function (e) {
          log.error(e);
          setStatus(pr.base.repo.owner.login, pr.base.repo.name, pr.head.sha, 'error', 'Error creating CI build');
        });
    } else {
      log.info('Action "' + req.body.action + '" not handled.');
    }
    res.status(204).send();
  } else {
    res.status(400).send();
  }
});

app.post('/jenkins', function (req, res) {
  log.info('Received Jenkins notification.');
  if (req.body && req.body.build) {
    var pr = activeBuilds[req.body.build.parameters.sha1];
    if (pr) {
      switch (req.body.build.phase) {
        case 'STARTED':
          setStatus(pr.baseUser, pr.baseRepo, pr.sha, 'pending', 'Building with Jenkins', req.body.build.full_url);
          superagent.post(req.body.build.full_url + '/submitDescription')
            .type('form')
            .send({
              description: pr.title,
              Submit: 'Submit' 
            })
            .end();
          break;
        case 'COMPLETED':
          setStatus(pr.baseUser, pr.baseRepo, pr.sha,
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

/**
 * When a pull_request event is received, creates a new commit in the Build repo that references the
 * PR's commit (in a submodule) and starts a build.
 */
function processPullRequest(pullRequest) {
  var pr = {
    baseUser: pullRequest.base.repo.owner.login,
    baseRepo: pullRequest.base.repo.name,
    baseBranch: pullRequest.base.ref,
    headUser: pullRequest.head.repo.owner.login,
    headRepo: pullRequest.head.repo.name,
    sha: pullRequest.head.sha,
    title: 'PR #' + pullRequest.number + ': ' + pullRequest.title
  };
  return leeroyBranches.then(function (lb) {
    var key = pr.baseUser + '/' + pr.baseRepo + '/' + pr.baseBranch;
    log.info('Received pull_request event for ' + key + ': SHA = ' + pr.sha);
    if (lb[key]) {
      return setStatus(pr.baseUser, pr.baseRepo, pr.sha, 'pending', 'Preparing build')
        .then(function () {
          return Promise.all(lb[key].map(function (leeroyConfig) {
            var buildUserRepo = leeroyConfig.repoUrl.match(buildRepoUrl);
            var build = {
              config: leeroyConfig,
              repo: github.repos(buildUserRepo[1], buildUserRepo[2])
            };
            return getHeadCommit(pr, build)
              .then(function (commit) {
                return createNewCommit(pr, build, commit);
              })
              .then(function (newCommit) {
                return createRef(pr, build, newCommit)
                  .then(function() {
                    activeBuilds[newCommit.sha] = pr;
                    return Promise.all(build.config.pullRequestBuildUrls.map(function (prBuildUrl) {
                      log.info('Starting a build at ' + prBuildUrl);
                      return superagent
                        .get(prBuildUrl)
                        .query({ sha1: newCommit.sha });
                    }));
                  });                    
              });
          }));
        });
    } else {
      log.info('No PR builds set up for ' + key);
    }
  });
}

/**
 * Calls the GitHub Status API to set the state for 'sha'.
 * See https://developer.github.com/v3/repos/statuses/#create-a-status for parameter descriptions.
 */
function setStatus(user, repo, sha, state, description, targetUrl) {
  return github.repos(user, repo).statuses(sha).create({
    state: state,
    description: description,
    target_url: targetUrl,
    context: 'leeroy-pull-request-builder'
  });
}

/**
 * Returns a promise for the SHA of the head of the build repo branch specified by
 * the Leeroy config in 'build.config'.
 */
function getHeadCommit(pr, build) {
  return build.repo.git.refs('heads', build.config.branch).fetch()
    .then(function (ref) {
      log.info('Repo ' + build.config.repoUrl + ' is at commit ' + ref.object.sha);
      return build.repo.git.commits(ref.object.sha).fetch();
    });
}

/**
 * Returns a promise for a new build repo commit that updates the specified 'commit'
 * with updated submodules for 'pr'.
 */
function createNewCommit(pr, build, commit) {
  return build.repo.git.trees(commit.tree.sha).fetch()
    .then(function(tree) {
      return createNewTree(pr, build, tree);
    })
    .then(function (newTree) {
      log.info('newTree = ' + newTree.sha);
      return build.repo.git.commits.create({
        message: pr.title,
        tree: newTree.sha,
        parents: [ commit.sha ]
      });
    });
}

/**
 * Returns a promise for a new tree that updates .gitmodules and the submodules
 * in 'tree' with the updated submodules for 'pr'.
 */
function createNewTree(pr, build, tree) {
  // find the submodule that needs to be changed and update its SHA
  var newItems = tree.tree.filter(function (treeItem) {
    if (treeItem.mode === '160000' && treeItem.path == pr.baseRepo) {
      treeItem.sha = pr.sha;
      return true;
    }
    return false;
  });

  // find the .gitmodules file
  var gitmodulesItem = tree.tree.filter(function (treeItem) {
    return treeItem.path === '.gitmodules';
  })[0];

  // get the contents of .gitmodules
  return build.repo.git.blobs(gitmodulesItem.sha).fetch()
    .then(function (blob) {
      // update .gitmodules with the repo URL the PR is coming from (because it has the commit we need)
      var gitmodules = new Buffer(blob.content, 'base64').toString('utf-8')
        .replace('git@git:' + pr.baseUser + '/' + pr.baseRepo + '.git', 'git@git:' + pr.headUser + '/' + pr.headRepo + '.git');
      return build.repo.git.blobs.create({
        content: gitmodules
      });
    })
    .then(function (newBlob) {
      // create a new tree with updated submodules and .gitmodules
      gitmodulesItem.sha = newBlob.sha;
      newItems.push(gitmodulesItem);
      return build.repo.git.trees.create({
        base_tree: tree.sha,
        tree: newItems
      });
    })
}

/**
 * Updates the 'lprb' (Leeroy Pull Request Builder) branch in 'build' to point at the specified commit SHA.
 */
function createRef(pr, build, newCommit) {
  log.info('New commit is ' + newCommit.sha + '; updating ref.');
  var refName = 'heads/lprb';
  return build.repo.git.refs(refName).fetch()
    .then(function () {
      return build.repo.git.refs(refName).update({
        sha: newCommit.sha,
        force: true
      });
    }, function() {
      return build.repo.git.refs.create({
        ref: 'refs/' + refName,
        sha: newCommit.sha
      });                  
  });
}

/**
 * Gets all the repos+branches that have pullRequestBuildUrls set in their Leeroy configs.
 */
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
