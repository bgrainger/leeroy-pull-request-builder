const bodyParser = require('body-parser');
const buildConfig = require('./build-config.js');
const express = require('express');
const log = require('./logger');
const octokat = require('octokat');
const pullRequest = require('./pull-request');
const repoBranch = require('./repo-branch');
const rx = require('rx');
const state = require('./state');
const superagent = require('superagent-promise')(require('superagent'), Promise);

rx.config.longStackSupport = true;

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

const app = express();
app.use(bodyParser.json());
app.get('/', (req, res) => res.send('leeroy-pull-request-builder'));
app.post('/event_handler', gitHubWebHookHandler);
app.post('/jenkins', jenkinsWebHookHandler);

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
	jenkinsSubject.onNext(req.body);
	res.status(204).send();
};

function mapGitHubPullRequest(ghpr) {
	return pullRequest.create(repoBranch.create(ghpr.base.repo.owner.login, ghpr.base.repo.name, ghpr.base.ref),
		repoBranch.create(ghpr.head.repo.owner.login, ghpr.head.repo.name, ghpr.head.ref),
		ghpr.number,
		`PR #${ghpr.number}: ${ghpr.title}`);
}

function getGitHubPullRequestId(ghpr) {
	return mapGitHubPullRequest(ghpr).id;
}

const buildRepoUrl = /^git@git:([^/]+)\/([^.]+).git$/;
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

/**
 * Calls the GitHub Status API to set the state for the primary pull request in 'buildData'.
 * See https://developer.github.com/v3/repos/statuses/#create-a-status for parameter descriptions.
 */
function setStatus(buildData, context, state, description, target_url) {
	return github.repos(buildData.pullRequests[0].base.user, buildData.pullRequests[0].base.repo)
		.statuses(buildData.gitHubPullRequests[0].head.sha)
		.create({ state, description, target_url, context });
}

/**
 * Calls the GitHub Status API to set the state to "pending" using a unique context for each element
 * of `buildData.config.jobs`.
 */
function setPendingStatus(buildData, description) {
	return Promise.all(buildData.config.jobs.map(job => setStatus(buildData,
		`Jenkins: ${job.name}`,
		'pending',
		description)));
}

function fetchTreeAndGitmodules(buildData) {
	return buildData.github.git.refs('heads', buildData.config.repo.branch).fetch()
		.then(ref => buildData.github.git.commits(ref.object.sha).fetch())
		.then(headCommit => buildData.github.git.trees(headCommit.tree.sha).fetch()
			.then(headTree => {
				const gitmodulesItem = headTree.tree.filter(x => x.path === '.gitmodules')[0];
				return buildData.github.git.blobs(gitmodulesItem.sha).fetch()
					.then(blob => {
						const gitmodules = new Buffer(blob.content, 'base64').toString('utf-8');
						return { headCommit, headTree, gitmodules };					
					});
			}));
}

function fetchGitHubPullRequests(buildData) {
	return Promise.all(buildData.pullRequests.map(pr => github.repos(pr.base.user, pr.base.repo).pulls(pr.number).fetch()))
		.then(gitHubPullRequests => ({ gitHubPullRequests }));
}

function createNewCommit(buildData) {
	const newTreeItems = [];
	for (var i = 0; i < buildData.pullRequests.length; i++) {
		const pr = buildData.pullRequests[i];
		const treeItem = buildData.headTree.tree.filter(x => x.mode === '160000' && x.path == pr.base.repo)[0];
		if (treeItem) {
			const oldSubmodule = `git@git:${pr.base.user}/${pr.base.repo}.git`;
			const newSubmodule = `git@git:${pr.head.user}/${pr.head.repo}.git`;
			log.debug(`Changing submodule repo from ${oldSubmodule} to ${newSubmodule}`);
			buildData.gitmodules = buildData.gitmodules.replace(oldSubmodule, newSubmodule);

			var newSubmoduleSha = buildData.gitHubPullRequests[i].head.sha;
			log.debug(`Changing submodule SHA from ${treeItem.sha.substr(0, 8)} to ${newSubmoduleSha.substr(0, 8)}`);
			treeItem.sha = newSubmoduleSha;
			newTreeItems.push(treeItem);
		} else {
			log.debug(`Submodule ${pr.base.repo} not found; skipping`);
		}
	}

	const gitmodulesItem = buildData.headTree.tree.filter(x => x.path === '.gitmodules')[0];
	return buildData.github.git.blobs.create({ content: buildData.gitmodules })
		.then(newBlob => {
			log.debug(`New blob SHA is ${newBlob.sha}`);
			gitmodulesItem.sha = newBlob.sha;
			newTreeItems.push(gitmodulesItem);
			return buildData.github.git.trees.create({
				base_tree: buildData.headTree.sha,
				tree: newTreeItems
			})
		})
		.then(newTree => {
			log.debug(`New tree SHA is ${newTree.sha}`);
			return buildData.github.git.commits.create({
				message: buildData.pullRequests[0].title,
				tree: newTree.sha,
				parents: [ buildData.headCommit.sha ]
			})
		})
		.then(newCommit => {
			const buildBranchName = `heads/lprb-${buildData.config.repo.branch}-${buildData.pullRequests[0].number}`;
			log.info(`New commit SHA is ${newCommit.sha}; moving ${buildData.config.repo.user}/${buildData.config.repo.repo}${buildBranchName}`);
			return buildData.github.git.refs(buildBranchName).fetch()
				.then(() => buildData.github.git.refs(buildBranchName).update({
					sha: newCommit.sha,
					force: true
				}), () => buildData.github.git.refs.create({
					ref: 'refs/' + buildBranchName,
					sha: newCommit.sha
				}))
				.then(newRef => ({ newCommit, buildBranchName }));
		});
}

let activeBuilds = new Map();

function startBuilds(buildData) {
	activeBuilds.set(buildData.newCommit.sha, buildData);	
	return Promise.all(buildData.config.jobs.map(job => {
		log.info(`Starting a build at ${job.url}`);
		return superagent.get(job.url).query({ sha1: buildData.newCommit.sha });
	}));
}

function buildPullRequest(prId) {
	log.info(`Received build request for ${prId}.`);
	const pr = state.getPr(prId);

	// call buildPullRequest (recursively) to build all PRs that include this PR
	const builtConfigs = rx.Observable.from(state.getIncludingPrs()).flatMap(prId => buildPullRequest(prId)).toSet();

	// find all the configurations this PR affects
	const configsToBuild = builtConfigs.flatMap(previouslyBuilt => state.getPrBuilds(pr).filter(x => !previouslyBuilt.has(x)));

	/**
	 * buildData is an object about the build with the following properties:
	 * 	config : a buildConfig
	 * 	github : an octokat 'repo' object for the Build repo
	 * 	headCommit : a GitHub Git Commit object for the HEAD of the branch to build in the Build Repo; see https://developer.github.com/v3/git/commits/
	 * 	headTree : a GitHub Git Tree object for that commit's tree; see https://developer.github.com/v3/git/trees/
	 *	gitmodules : the contents of the '.gitmodules' file in the Build repo
	 * 	pullRequests : an array of pullRequest objects that need to be included
	 * 	gitHubPullRequests : an array of GitHub Pull Request objects one for the tip of each item in pullRequests (above); see https://developer.github.com/v3/pulls/#get-a-single-pull-request
	 */
	// set the config, github and pullRequests properties 
	let buildDatas = configsToBuild
		.do(config => log.info(`Will build ${config.id}`))
		.map(config => ({
			config,
			github: github.repos(config.repo.user, config.repo.repo),
			pullRequests: Array.from(state.getIncludedPrs(prId)).map(state.getPr)
		}));

	// add the headCommit, headTree, and gitmodules properties
	buildDatas = buildDatas.flatMap(fetchTreeAndGitmodules, Object.assign);

	// add the gitHubPullRequests properties
	buildDatas = buildDatas.flatMap(fetchGitHubPullRequests, Object.assign);			

	var subject = new rx.ReplaySubject();
	buildDatas
		.flatMap(buildData => setPendingStatus(buildData, 'Preparing Jenkins build'), (buildData, statuses) => buildData)
		.flatMap(createNewCommit, Object.assign)
		.flatMap(startBuilds, (buildData, ignored) => buildData)
		.subscribe(buildData => {
			subject.onNext(buildData.config.id);
		}, e => {
			log.error(e);
			subject.onError(e);
		}, () => {
			subject.onCompleted();
		});
	return subject;
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
	.filter(pr => pr.action === 'opened')
	.pluck('pull_request');
const allPrs = existingPrs.merge(newPrs);

allPrs
	.map(mapGitHubPullRequest)
	.subscribe(state.addPullRequest, e => log.error(e));

const allPrBodies = allPrs.map(x => ({ id: getGitHubPullRequestId(x), body: x.body }));
const existingIssueComments = existingPrs
	.flatMap(x => github.repos(x.base.repo.owner.login, x.base.repo.name).issues(x.number).comments.fetch().then(y => ({ id: getGitHubPullRequestId(x), body: y.body })));
const newIssueComments = gitHubSubjects['issue_comment']
	.map(ic => ({ id: `${ic.repository.full_name}/${ic.issue.number}`, body: ic.comment.body }));

const includePr = /Include https:\/\/git\/(.*?)\/(.*?)\/pull\/(\d+)/i;
allPrBodies.merge(existingIssueComments).merge(newIssueComments)
	.map(x => ({ id: x.id, match: includePr.exec(x.body) }))
	.filter(x => x.match)
	.map(x => ({ parent: x.id, child: `${x.match[1]}/${x.match[2]}/${x.match[3]}` }))
	.subscribe(x => state.addPullRequestDependency(x.parent, x.child), e => log.error(e));

newIssueComments.subscribe(comment => {
	if (/rebuild this/i.test(comment.body))
		buildPullRequest(comment.id);
}, e => log.error(e));

gitHubSubjects['pull_request']
	.filter(pr => pr.action === 'opened' || pr.action === 'synchronize')
	.pluck('pull_request')
	.map(mapGitHubPullRequest)
	.delaySubscription(1000) // feels hacky but we need state to have been updated
	.subscribe(pr => {
		buildPullRequest(pr.id);
	}, e => log.error(e));

var jenkinsNotifications = jenkinsSubject
	.do(job => log.debug(`Received ${job.build.phase} notification for ${job.name}`))
	.map(job => ({ job, buildData: activeBuilds.get(job.build.parameters.sha1) }))
	.filter(x => x.buildData)
	.do(x => log.debug(`Corresponding build config is ${x.buildData.config.id}`))
	.share();

jenkinsNotifications
	.filter(x => x.job.build.phase === 'STARTED')
	.subscribe(x => {
		setStatus(x.buildData, `Jenkins: ${x.job.name}`, 'pending', 'Building with Jenkins', x.job.build.full_url);
		superagent.post(x.job.build.full_url + '/submitDescription')
			.type('form')
			.send({ description: x.buildData.pullRequests[0].title, Submit: 'Submit' })
			.end();
	}, e => log.error(e));

jenkinsNotifications
	.filter(x => x.job.build.phase === 'COMPLETED')
	.do(x => log.info(`Job ${x.job.name} status is ${x.job.build.status}`))
	.subscribe(x => {
		setStatus(x.buildData,
			`Jenkins: ${x.job.name}`,
			x.job.build.status === 'SUCCESS' ? 'success' : 'failure',
			`Jenkins build status: ${x.job.build.status}`,
			x.job.build.full_url);
		x.buildData.github.git.refs(x.buildData.buildBranchName).remove()
			.then(success => log.debug(`Branch ${x.buildData.buildBranchName} was ${success ? '' : 'not '}deleted`));
	}, e => log.error(e));

let started = false;
function startServer(port) {
	if (started)
		throw new Error('Server is already started.');
	started = true;
	log.info(`Starting server on port ${port}`);
	app.listen(port);
}

exports.start = startServer;
