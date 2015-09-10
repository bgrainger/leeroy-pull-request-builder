const bodyParser = require('body-parser');
const buildConfig = require('./build-config.js');
const express = require('express');
const log = require('./logger');
const octokat = require('octokat');
const rx = require('rx');
const state = require('./state');
const pullRequest = require('./pull-request');
const repoBranch = require('./repo-branch');

rx.config.longStackSupport = true;

const app = express();
app.use(bodyParser.json());

const github = new octokat({
	token: process.env.GITHUB_TOKEN,
	rootURL: 'https://git/api/v3'
})

const gitHubSubjects = {
	'issue_comment': new rx.Subject(),
	'push': new rx.Subject(),
	'pull_request': new rx.Subject(),
	'ping': new rx.Subject()
};

const jenkinsSubject =new rx.Subject(); 

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

function mapGitHubPullRequest(ghpr) {
	return pullRequest.create(repoBranch.create(ghpr.base.repo.owner.login, ghpr.base.repo.name, ghpr.base.ref),
		repoBranch.create(ghpr.head.repo.owner.login, ghpr.head.repo.name, ghpr.head.ref),
		ghpr.number,
		`PR #${ghpr.number}: ${ghpr.title}`);
}

function getGitHubPullRequestId(ghpr) {
	return mapGitHubPullRequest(ghpr).id;
}

function mapLeeroyConfig(name, leeroyConfig) {
	let [, user, repo] = buildRepoUrl.exec(leeroyConfig.repoUrl) || [];
	return buildConfig.create(
		name,
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

// update Leeroy configs every time Build/Configuration is pushed
gitHubSubjects['push']
	.filter(push => push.repository.full_name === 'Build/Configuration' && push.ref === 'refs/heads/master')
	.startWith(null)
	.flatMap(() => github.repos('Build', 'Configuration').contents.fetch())
	.do(contents => log.debug(`Build/Configuration has ${contents.length} files.`))
	.flatMap(contents => contents.filter(x => x.path.indexOf('.json') === x.path.length - 5))
	.flatMap(file => github.repos('Build', 'Configuration').contents(file.path).read().then(contents => ({ path: file.path, contents })))
	.map(x => { try { return { path: x.path, config: JSON.parse(x.contents) }; } catch(e) { return null; } })
	.filter(x => x && !x.config.disabled && x.config.submodules && x.config.pullRequestBuildUrls && buildRepoUrl.test(x.config.repoUrl))
	.map(x => mapLeeroyConfig(x.path.substr(0, x.path.length - 5), x.config))
	.subscribe(state.addBuildConfig, e => log.error(e));

// get all existing open PRs when new repos are watched
const existingPrs = state.watchedRepos
	.flatMap(repo => github.repos(repo).pulls.fetch())
	.flatMap(pulls => pulls);
// merge with new PRs that are opened while the server is running
const newPrs = gitHubSubjects['pull_request']
	.filter(pr => pr.action === 'opened');
const allPrs = existingPrs.merge(newPrs);

allPrs
	.map(mapGitHubPullRequest)
	.subscribe(state.addPullRequest);

const allPrBodies = allPrs.map(x => ({ id: getGitHubPullRequestId(x), body: x.body }));
const existingIssueComments = existingPrs
	.flatMap(x => github.repos(x.base.repo.owner.login, x.base.repo.name).issues(x.number).comments.fetch().then(y => ({ id: getGitHubPullRequestId(x), body: y.body })));
const newIssueComments = gitHubSubjects['issue_comment']
	.map(ic => ({ id: `${ic.repository.full_name}/${ic.issue.number}`, body: ic.comment.body }));
	
allPrBodies.merge(existingIssueComments).merge(newIssueComments)
	.map(x => ({ id: x.id, match: includePr.exec(x.body) }))
	.filter(x => x.match)
	.map(x => ({ parent: x.id, child: `${x.match[1]}/${x.match[2]}/${x.match[3]}` }))
	.subscribe(x => state.addPullRequestDependency(x.parent, x.child), e => log.error(e));

let started = false;
function startServer(port) {
	if (started)
		throw new Error('Server is already started.');
	started = true;
	log.info(`Starting server on port ${port}`);
	app.listen(port);
}

exports.start = startServer;
