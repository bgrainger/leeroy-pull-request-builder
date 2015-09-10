const bodyParser = require('body-parser');
const buildConfig = require('./build-config.js');
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

const buildRepoUrl = /^git@git:([^/]+)\/([^.]+).git$/;
const includePr = /Include https:\/\/git\/(.*?)\/(.*?)\/pull\/(\d+)/i;

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
        return f && !f.disabled && f.submodules && f.pullRequestBuildUrls && buildRepoUrl.test(f.repoUrl);
      });
      log.info(`Found ${configs.length} enabled files with submodules and PR build URLs.`);
      return configs;
    });
}

function mapGitHubPullRequest(ghpr) {
  return pullRequest.create(repoBranch.create(ghpr.base.repo.owner.login, ghpr.base.repo.name, ghpr.base.ref),
    repoBranch.create(ghpr.head.repo.owner.login, ghpr.head.repo.name, ghpr.head.ref),
    ghpr.number,
    `PR #${ghpr.number}: ${ghpr.title}`);
}

function mapLeeroyConfig(leeroyConfig) {
	let [, user, repo] = buildRepoUrl.exec(leeroyConfig.repoUrl) || [];
	return buildConfig.create(
	  repoBranch.create(user, repo, leeroyConfig.branch || 'master'),
		leeroyConfig.pullRequestBuildUrls.map(function (buildUrl) {
			var match = /\/job\/([^/]+)\/buildWithParameters/.exec(buildUrl);
			return {
				name: match && match[1],
				url: buildUrl
			};
		})
			.filter(job => job.name ? true : false),
    leeroyConfig.submodules
  );
}

function addPullRequest(gitHubPullRequest) {
  var pr = mapGitHubPullRequest(gitHubPullRequest);
  pr = state.addPullRequest(pr);
  return Promise.all(github.repos(gitHubPullRequest.base.repo.owner.login, gitHubPullRequest.base.repo.name)
    .issues(gitHubPullRequest.number).comments.fetch()
    .then(comments => {
      for (var comment of [ gitHubPullRequest.body ].concat(comments.map(x => x.body))) {
        var match = includePr.exec(comment);
        if (match) {
          let included = `${match[1]}/${match[2]}/${match[3]}`;
          pr.addInclude(included);
          log.info(`${pr.id} includes ${included}`);
        }
      }
    }));
}

// observable of all pushes to Build/Configuration
const configurationPushes = gitHubSubjects['push']
  .filter(push => push.repository.full_name === 'Build/Configuration' && push.ref === 'refs/heads/master')
  .startWith(null)
  .flatMap(rx.Observable.fromPromise(getLeeroyConfigs()));

// update Leeroy configs every time Build/Configuration is pushed
configurationPushes.flatMap(rx.Observable.from).map(mapLeeroyConfig).subscribe(state.addBuildConfig);

// get all existing open PRs when Build/Configuration is pushed
configurationPushes.subscribe(x => {
  state.getReposToWatch().map(repo => github.repos(repo).pulls.fetch()
    .then(pulls => Promise.all(pulls.map(x => addPullRequest(x)))))
    .then(null, e => log.error(e));
});

// add all new PRs
gitHubSubjects['pull_request'].filter(pr => pr.action === 'opened')
  .subscribe(pr => addPullRequest(pr).then(null, e => log.error(e)));

let started = false;
function startServer(port) {
	if (started)
		throw new Error('Server is already started.');
	started = true;
	log.info(`Starting server on port ${port}`);
	app.listen(port);	
}

exports.start = startServer;
