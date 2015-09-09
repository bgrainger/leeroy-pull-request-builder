const bodyParser = require('body-parser');
const express = require('express');
const log = require('./logger');
const octokat = require('octokat');
const rx = require('rx');
const state = require('./state');
const pullRequest = require('./pull-request');
const repoBranch = require('./repo-branch');

let app = express();
app.use(bodyParser.json());

let github = new octokat({
  token: process.env.GITHUB_TOKEN,
  rootURL: 'https://git/api/v3'
})

let gitHubSubjects = {
	'issue_comment': new rx.Subject(),
	'push': new rx.Subject(),
	'pull_request': new rx.Subject(),
	'ping': new rx.Subject()
};

let jenkinsSubject =new rx.Subject(); 

function gitHubWebHookHandler(req, res) {
	const gitHubEvent = req.headers['x-github-event'];
	const subject = gitHubSubjects[gitHubEvent];
	if (subject) {
		subject.onNext(req.body);
		res.status(204).send();
	} else {
		res.status(400).send();
	}
};

function jenkinsWebHookHandler(req, res) {
	this.jenkinsSubject.onNext(req.body);
	res.status(204).send();
};

app.get('/', (req, res) => res.send('leeroy-pull-request-builder'));
app.post('/event_handler', gitHubWebHookHandler);
app.post('/jenkins', jenkinsWebHookHandler);

function getLeeroyConfigs() {
  return github.repos('Build', 'Configuration').contents.fetch()
    .then(function (contents) {
      log.debug(`Build/Configuration has ${contents.length} files.`);
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
              // log.debug('Invalid JSON in ' + elem.path);
              return null;
            }
          });
      }));
    })
    .then(function (files) {
      var configs = files.filter(function (f) {
        return f && !f.disabled && f.submodules && f.pullRequestBuildUrls;
      });
      log.info(`Found ${configs.length} enabled files with submodules and PR build URLs.`);
      return configs;
    });
}

const includePr = /Include https:\/\/git\/(.*?)\/(.*?)\/pull\/(\d+)/i;

function createPullRequest(pr) {
  return pullRequest.create(repoBranch.create(pr.base.repo.owner.login, pr.base.repo.name, pr.base.ref),
    repoBranch.create(pr.head.repo.owner.login, pr.head.repo.name, pr.head.ref),
    pr.number,
    `PR #${pr.number}: ${pr.title}`);
}

function addPullRequest(gitHubPullRequest) {
  var pr = createPullRequest(gitHubPullRequest);
  state.addPullRequest(pr);
  return Promise.all(github.repos(gitHubPullRequest.base.repo.owner.login, gitHubPullRequest.base.repo.name)
    .issues(gitHubPullRequest.number).comments.fetch()
    .then(comments => {
      for (var comment of [ gitHubPullRequest.body ].concat(comments.map(x => x.body))) {
        var match = includePr.exec(comment);
        if (match) {
          log.info(`${pr.id} includes ${match[1]}/${match[2]}/${match[3]}`);
        }
      }
    }));
}

getLeeroyConfigs().then(configs => {
	for (let config of configs)
		state.addLeeroyConfig(config);
})
  .then(() => state.getReposToWatch().map(repo => github.repos(repo).pulls.fetch()
    .then(pulls => Promise.all(pulls.map(x => addPullRequest(x))))))
  .then(null, e => log.error(e));

let started = false;
function startServer(port) {
	if (started)
		throw new Error('Server is already started.');
	started = true;
	log.info(`Starting server on port ${port}`);
	app.listen(port);	
}

exports.github = gitHubSubjects;
exports.jenkins = jenkinsSubject;
exports.start = startServer;
