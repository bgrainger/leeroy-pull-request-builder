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

function buildPullRequestPromise(prId) {
	log.info(`Received build request for ${prId}.`);
	return Promise.all(Array.from(state.getIncludingPrs()).map(prId => buildPullRequestPromise(prId)))
		.then(x => [].concat.apply([], x))
		.then(configs => {
			log.info(`Previously built configs for ${prId} are: ${configs}`);
			const previouslyBuilt = new Set(configs);

			const pr = state.getPr(prId);
			const buildConfigs = state.getPrBuilds(pr).filter(x => !previouslyBuilt.has(x));
			log.info(`Configs to build are: ${buildConfigs.map(x => x.id)}`);
			return Promise.all(configs.map(config => {

			}));
		});
	// build all including PRs, get their build configs
	// find all affected build configs (minus previously built); for each:
		// get head commit, tree, .gitmodules blob
		// get all included PRs; for each:
			// update tree sha
			// update .gitmodules path
		// create .gitmodules blob
		// create new tree
		// create new commit
		// for each job:
			// set pending status
			// submit to Jenkins
}

function readTreeAndGitmodules(repo, commit) {
	return repo.git.trees(commit.tree.sha).fetch()
		.then(tree => {
			const gitmodulesItem = tree.tree.filter(x => x.path === '.gitmodules')[0];
			return repo.git.blobs(gitmodulesItem.sha).fetch()
				.then(blob => {
					const gitmodules = new Buffer(blob.content, 'base64').toString('utf-8');
					return { headCommit: commit, headTree: tree, gitmodules };					
				});
		});
}

function createNewCommit(buildData, includedPrIds) {
	var includedPrs = Array.from(includedPrIds).map(state.getPr);
	return Promise.all(includedPrs.map(pr => github.repos(pr.base.user, pr.base.repo).pulls(pr.number).fetch().then(ghpr => ({ pr, ghpr }))))
		.then(prs => {
			const newTreeItems = [];
			for (let pr of prs) {
				const oldSubmodule = `git@git:${pr.pr.base.user}/${pr.pr.base.repo}.git`;
				const newSubmodule = `git@git:${pr.pr.head.user}/${pr.pr.head.repo}.git`;
				log.debug(`Changing submodule repo from ${oldSubmodule} to ${newSubmodule}`);
				buildData.gitmodules = buildData.gitmodules.replace(oldSubmodule, newSubmodule);

				var treeItem = buildData.headTree.tree.filter(x => x.mode === '160000' && x.path == pr.pr.base.repo)[0];
				log.debug(`Changing submodule SHA from ${treeItem.sha.substr(0, 8)} to ${pr.ghpr.head.sha.substr(0, 8)}`);
				treeItem.sha = pr.ghpr.head.sha;
				newTreeItems.push(treeItem);
			}

			const gitmodulesItem = buildData.headTree.tree.filter(x => x.path === '.gitmodules')[0];
			return buildData.github.git.blobs.create({ content: buildData.gitmodules })
				.then(newBlob => {
					gitmodulesItem.sha = newBlob.sha;
					newTreeItems.push(gitmodulesItem);
					return buildData.github.git.trees.create({
						base_tree: buildData.headTree.sha,
						tree: newTreeItems
					});
		})
		.then(newTree => {
			log.debug(`New tree SHA is ${newTree.sha}`);
			return buildData.github.git.commits.create({
				message: includedPrs[0].title,
				tree: newTree.sha,
				parents: [ buildData.headCommit.sha ]
			})
				.then(commit => {
					log.info(`New commit in ${buildData.config.repo.user}/${buildData.config.repo.repo} has SHA ${commit.sha}`);
					return { newCommit: commit };
				});
		});
	});
}

function buildPullRequest(prId) {
	log.info(`Received build request for ${prId}.`);
	const pr = state.getPr(prId);
	
	const builtConfigs = rx.Observable.from(state.getIncludingPrs()).flatMap(prId => buildPullRequest(prId)).toSet();
	const configsToBuild = builtConfigs.flatMap(previouslyBuilt => state.getPrBuilds(pr).filter(x => !previouslyBuilt.has(x)));
	const buildDatas = configsToBuild
		.do(config => log.debug(`Will build ${config.id}`))
		.map(config => ({ config, github: github.repos(config.repo.user, config.repo.repo) }))
		.flatMap(x => x.github.git.refs('heads', x.config.repo.branch).fetch()
			.then(ref => x.github.git.commits(ref.object.sha).fetch())
			.then(commit => readTreeAndGitmodules(x.github, commit))
			.then(y => Object.assign(x, y)));

	const updatedCommits = buildDatas.flatMap(x => createNewCommit(x, state.getIncludedPrs(prId)).then(y => Object.assign(x, y)));

	updatedCommits.subscribe(x => log.info(x), e => log.error(e));

	return new rx.Subject();	
	// build all including PRs, get their build configs
	// find all affected build configs (minus previously built); for each:
		// get head commit, tree, .gitmodules blob
		// get all included PRs; for each:
			// update tree sha
			// update .gitmodules path
		// create .gitmodules blob
		// create new tree
		// create new commit
		// for each job:
			// set pending status
			// submit to Jenkins
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

newIssueComments.subscribe(comment => {
	if (/rebuild this/i.test(comment.body))
		buildPullRequest(comment.id);
});

let started = false;
function startServer(port) {
	if (started)
		throw new Error('Server is already started.');
	started = true;
	log.info(`Starting server on port ${port}`);
	app.listen(port);
}

exports.start = startServer;
