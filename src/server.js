import bodyParser from 'body-parser';
import * as buildConfig from './build-config.js';
import express from 'express';
import log from './logger';
import octokat from 'octokat';
import * as pullRequest from './pull-request';
import * as repoBranch from './repo-branch';
import rx from 'rx';
import * as state from './state';
import superagent_base from 'superagent';
import superagent_promise from 'superagent-promise';
const superagent = superagent_promise(superagent_base, Promise);
const url = require('url');
const version = require('../package.json').version;

rx.config.longStackSupport = true;

let github;

/**
 * An Observable sequence of GitHub event payloads (see https://developer.github.com/v3/activity/events/types/)
 * for each of the named event types.
 */
const gitHubEvents = {
	'issue_comment': new rx.Subject(),
	'push': new rx.Subject(),
	'pull_request': new rx.Subject(),
	'ping': new rx.Subject()
};

/**
 * An Observable sequence of Jenkins notifications (see JSON format at https://wiki.jenkins-ci.org/display/JENKINS/Notification+Plugin).
 */
const jenkinsEvents = new rx.Subject();

let uniqueSuffix = 1;

const app = express();
app.use(bodyParser.json());
app.get('/', (req, res) => res.send(`leeroy-pull-request-builder ${version}`));
app.post('/github', gitHubWebHookHandler);
app.post('/jenkins', jenkinsWebHookHandler);

function gitHubWebHookHandler(req, res) {
	const gitHubEvent = req.headers['x-github-event'];
	const subject = gitHubEvents[gitHubEvent];
	if (subject) {
		subject.onNext(req.body);
		res.status(204).send();
	} else {
		res.status(400).send();
	}
}

function jenkinsWebHookHandler(req, res) {
	jenkinsEvents.onNext(req.body);
	res.status(204).send();
}

/**
 * Creates a pullRequest object from a GitHub Pull Request JSON object (as documented
 * here: https://developer.github.com/v3/pulls/#get-a-single-pull-request).
 */
function mapGitHubPullRequest(ghpr) {
	return pullRequest.create(repoBranch.create(ghpr.base.repo.owner.login, ghpr.base.repo.name, ghpr.base.ref),
		repoBranch.create(ghpr.head.repo.owner.login, ghpr.head.repo.name, ghpr.head.ref),
		ghpr.number,
		`PR${ghpr.number}: ${ghpr.title}`);
}

function getGitHubPullRequestId(ghpr) {
	return mapGitHubPullRequest(ghpr).id;
}

const buildRepoUrl = /^git@git:([^/]+)\/(.+?)\.git$/;

/**
 * Creates a buildConfig object from a Leeroy config JSON object (as documented
 * here: https://github.com/LogosBible/Leeroy#how-to-configure).
 */
function mapLeeroyConfig(name, leeroyConfig) {
	const [, user, repo] = buildRepoUrl.exec(leeroyConfig.repoUrl) || [];
	return buildConfig.create(
		name,
		repoBranch.create(user, repo, leeroyConfig.branch || 'master'),
		leeroyConfig.pullRequestBuildUrls.map(buildUrl => {
			var match = /\/job\/([^/]+)\/buildWithParameters/.exec(buildUrl);
			return {
				name: match && match[1],
				url: buildUrl
			};
		})
			.filter(job => job.name),
		leeroyConfig.submodules
	);
}

/**
 * Calls the GitHub Status API to set the state for the all pull requests in 'buildData'.
 * See https://developer.github.com/v3/repos/statuses/#create-a-status for parameter descriptions.
 */
function setStatus(buildData, context, statusState, description, target_url) {
	return Promise.all(buildData.pullRequests.map((pr, i) =>
		github.repos(pr.base.user, pr.base.repo)
			.statuses(buildData.gitHubPullRequests[i].head.sha)
			.create({ state: statusState, description, target_url, context })
	));
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

/**
 * Returns a Promise for `{ headCommit, headTree, gitmodules }` containing the GitHub git commit and
 * tree, and the contents of `.gitmodules` at the head of the build branch in the build repo.
 */
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

/**
 * Returns a Promise for `{ gitHubPullRequests: [ ghpr] }` for the GitHub Pull Request JSON object
 * for each pull request in `buildData`.
 */
function fetchGitHubPullRequests(buildData) {
	return Promise.all(buildData.pullRequests.map(pr => github.repos(pr.base.user, pr.base.repo).pulls(pr.number).fetch()))
		.then(gitHubPullRequests => ({ gitHubPullRequests }));
}

/**
 * Creates a new commit in the Build repo that updates all submodules affected by this pull request.
 * Returns a Promise for `{ newCommit, buildBranchName, submoduleBranches }` where:
 * - `newCommit` is a GitHub Git Commit JSON object for the new commit in the Build repo
 * - `buildBranchName` is a unique branch name in the Build repo that `newCommit` is the HEAD of
 * - `submoduleBranches` is an array of repoBranch objects for each submodule updated in the build
 */
function createNewCommit(buildData) {
	// use a unique branch name so that the build server has a permanent ref that won't have been
	// overwritten by the time the build starts
	const buildBranchName = `lprb-${buildData.config.repo.branch}-${buildData.pullRequests[0].number}-${uniqueSuffix}`;
	uniqueSuffix++;

	return Promise.all(buildData.pullRequests.map((pr, index) => {
		// create a merge commit for each submodule that has a PR involved in this build
		const oldSubmodule = `git@git:${pr.base.user}/${pr.base.repo}.git`;
		const newSubmodule = `git@git:${pr.head.user}/${pr.head.repo}.git`;
		const treeItem = buildData.headTree.tree.filter(x => x.mode === '160000' && x.path === pr.base.repo)[0];
		if (treeItem) {
			const githubBase = github.repos(pr.base.user, pr.base.repo);
			const prHeadSha = buildData.gitHubPullRequests[index].head.sha;
			return githubBase.git.refs('heads', pr.base.branch).fetch()
				.then(ref => ref.object.sha)
				.then(headSha => moveBranch(githubBase, buildBranchName, headSha)
					.then(() => {
						log.info(`Merging ${prHeadSha.substr(0, 8)} into ${buildBranchName} in ${pr.base.user}/${pr.base.repo}`);
						return githubBase.merges.create({
							base: buildBranchName,
							head: prHeadSha,
							commit_message: buildData.pullRequests[0].title
						});
					}))
				.then(merge => {
					log.info(`Merged ${prHeadSha.substr(0, 8)} into ${pr.base.user}/${pr.base.repo}/${buildBranchName}: SHA is ${merge.sha}`);
					return {
						user: pr.base.user,
						repo: pr.base.repo,
						treeItem: Object.assign(treeItem, { sha: merge.sha })
					};
				}, e => {
					log.error(`Couldn't merge ${prHeadSha.substr(0, 8)} into ${pr.base.user}/${pr.base.repo}/${buildBranchName}: ${e}`);
					// fall back to building with PR's commit instead of merge result
					return {
						user: pr.base.user,
						repo: pr.base.repo,
						treeItem: Object.assign(treeItem, { sha: prHeadSha }),
						oldSubmodule,
						newSubmodule
					};
				});
		} else {
			log.debug(`Submodule ${pr.base.repo} not found; skipping`);
			return Promise.resolve(null);
		}
	}))
		.then(submoduleTreeItems => submoduleTreeItems.filter(x => x))
		.then(submoduleTreeItems => {
			for (const submoduleTreeItem of submoduleTreeItems.filter(x => x.oldSubmodule)) {
				log.debug(`Changing submodule repo from ${submoduleTreeItem.oldSubmodule} to ${submoduleTreeItem.newSubmodule}`);
				buildData.gitmodules = buildData.gitmodules.replace(submoduleTreeItem.oldSubmodule, submoduleTreeItem.newSubmodule);
			}

			const newTreeItems = submoduleTreeItems.map(x => x.treeItem);
			const gitmodulesItem = buildData.headTree.tree.filter(x => x.path === '.gitmodules')[0];
			return buildData.github.git.blobs.create({ content: buildData.gitmodules })
				.then(newBlob => {
					log.debug(`New .gitmodules blob SHA is ${newBlob.sha}`);
					gitmodulesItem.sha = newBlob.sha;
					newTreeItems.push(gitmodulesItem);
					return buildData.github.git.trees.create({
						base_tree: buildData.headTree.sha,
						tree: newTreeItems.filter(x => x)
					});
				})
				.then(newTree => {
					log.debug(`New tree SHA is ${newTree.sha}`);
					return buildData.github.git.commits.create({
						message: buildData.pullRequests[0].title,
						tree: newTree.sha,
						parents: [ buildData.headCommit.sha ]
					});
				})
				.then(newCommit => {
					log.info(`New commit SHA is ${newCommit.sha}; moving ${buildData.config.repo.user}/${buildData.config.repo.repo}/${buildBranchName}`);
					return moveBranch(buildData.github, buildBranchName, newCommit.sha)
						.then(() => ({
							newCommit,
							buildBranchName,
							submoduleBranches: submoduleTreeItems.map(x => repoBranch.create(x.user, x.repo, buildBranchName))
						}));
				});
		});
}

/**
 * Forcibly updates `branch` to reference `sha` in the repo controlled by the octokat `repo` object.
 */
function moveBranch(repo, branch, sha) {
	const refName = `heads/${branch}`;
	return repo.git.refs(refName).fetch()
		.then(() => repo.git.refs(refName).update({ sha, force: true }),
			() => repo.git.refs.create({ sha, ref: `refs/${refName}` }));
}

const activeBuilds = new Map();

/**
 * Starts builds for all jobs in `buildData`.
 */
function startBuilds(buildData) {
	activeBuilds.set(buildData.newCommit.sha, buildData);
	buildData.jobCount = buildData.config.jobs.length;
	return Promise.all(buildData.config.jobs.map(job => {
		// Jenkins now requires a CSRF "crumb" to be sent in the HTTP headers; there is a separate API that issues them
		let getCrumb = Promise.resolve(null);
		if (job.url.match(/jenkins/)) {
			// TODO: decide if it's worth caching these for some time instead of requesting them for every single build
			var getCrumbUrl = url.resolve(job.url, '/crumbIssuer/api/json');
			log.info(`Getting crumb from ${getCrumbUrl}`);
			getCrumb = superagent.get(getCrumbUrl).then(x => {
				if (x && x.body && x.body.crumb) {
					log.debug(`Got crumb: ${x.body.crumb}`);
					return [ x.body.crumbRequestField, x.body.crumb ];
				} else {
					log.warn(`Unexpected crumb response: ${JSON.stringify(x)}`);
					return null;
				}
			}, err => {
				log.warn(`Getting crumb failed: ${err}`);
				return null;
			});
		}

		return getCrumb.then(crumb => {
			log.info(`Starting a build at ${job.url}`);
			var request = superagent
				.post(job.url)
				.query({ sha1: buildData.newCommit.sha });
			if (crumb) {
				request = request.set(crumb[0], crumb[1]);
			}
			return request.then(null, err => {
				log.warn(`Build didn't start: ${err}`);
				buildData.jobCount--;
			});
		});
	}));
}

/**
 * Starts all builds needed for `prId` (which should be in the form 'User/Repo/123').
 */
function buildPullRequest(prId, prsBeingBuilt = new Set()) {
	log.info(`Received build request for ${prId}.`);
	const pr = state.getPr(prId);

	// call buildPullRequest (recursively) to build all PRs that include this PR
	const prIdsToBuild = [ ];
	const allPrsBeingBuilt = new Set(prsBeingBuilt);
	for (const includingPrId of state.getIncludingPrs(prId)) {
		if (!prsBeingBuilt.has(includingPrId)) {
			prIdsToBuild.push(includingPrId);
			allPrsBeingBuilt.add(includingPrId);
		}
	}
	log.info(`${prId} has includingPrs: ${prIdsToBuild}`);
	const builtConfigs = rx.Observable.from(prIdsToBuild).flatMap(x => buildPullRequest(x, allPrsBeingBuilt)).toSet();

	// find all the configurations this PR affects
	const configsToBuild = builtConfigs.flatMap(previouslyBuilt => state.getPrBuilds(pr).filter(x => !previouslyBuilt.has(x.id)));

	/**
	 * buildData is an object about the build with the following properties:
	 * 	config : a buildConfig
	 * 	github : an octokat 'repo' object for the Build repo
	 * 	headCommit : a GitHub Git Commit object for the HEAD of the branch to build in the Build Repo; see https://developer.github.com/v3/git/commits/
	 * 	headTree : a GitHub Git Tree object for that commit's tree; see https://developer.github.com/v3/git/trees/
	 *	gitmodules : the contents of the '.gitmodules' file in the Build repo
	 * 	pullRequests : an array of pullRequest objects that need to be included
	 * 	gitHubPullRequests : an array of GitHub Pull Request objects, one for the tip of each item in pullRequests (above)
	 * 	newCommit : a GitHub Git Commit object for the new commit in the Build repo
	 * 	buildBranchName : the new branch name created in the Build repo for newCommit
	 * 	submoduleBranches : an array of repoBranch objects for each submodule updated by the build
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
		.flatMap(buildData => setPendingStatus(buildData, 'Preparing Jenkins build'), buildData => buildData)
		.flatMap(createNewCommit, Object.assign)
		.flatMap(startBuilds, buildData => buildData)
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
const pushedLeeroyConfigs = gitHubEvents.push
	.filter(push => push.repository.full_name === 'Build/Configuration' && push.ref === 'refs/heads/master')
	.startWith(null)
	.flatMap(() => github.repos('Build', 'Configuration').contents.fetch())
	.do(contents => log.debug(`Build/Configuration has ${contents.length} files.`))
	.flatMap(contents => contents.filter(x => x.path.indexOf('.json') === x.path.length - 5))
	.flatMap(file => github.repos('Build', 'Configuration').contents(file.path).read().then(contents => ({ path: file.path, contents })))
	.map(x => { try { return { path: x.path, config: JSON.parse(x.contents) }; } catch(e) { return null; } })
	.filter(x => x && !x.config.disabled && x.config.submodules && x.config.pullRequestBuildUrls && buildRepoUrl.test(x.config.repoUrl))
	.map(x => mapLeeroyConfig(x.path.substr(0, x.path.length - 5), x.config));

// get all existing open PRs when new repos are watched
const existingPrs = state.watchedRepos
	.flatMap(repo => github.repos(repo).pulls.fetch())
	.flatMap(pulls => pulls);
// merge with new PRs that are opened while the server is running
const newPrs = gitHubEvents.pull_request
	.filter(pr => pr.action === 'opened')
	.pluck('pull_request');
const allPrs = existingPrs.merge(newPrs);

// update state for each PR
allPrs
	.map(mapGitHubPullRequest)
	.subscribe(state.addPullRequest, e => log.error(e));

// get the comment in the body for each opened PR
const allPrBodies = allPrs.map(x => ({ id: getGitHubPullRequestId(x), body: x.body }));
// get all comments added to existing PRs
const existingIssueComments = existingPrs
	.flatMap(x => github.repos(x.base.repo.owner.login, x.base.repo.name).issues(x.number).comments.fetch().then(y => ({ id: getGitHubPullRequestId(x), body: y.body })));
// get all new comments that are added while the server is running
const newIssueComments = gitHubEvents.issue_comment
	.map(ic => ({ id: `${ic.repository.full_name}/${ic.issue.number}`, body: ic.comment.body }));

// look for "Includes ..." in all PR comments & update state
const includePr1 = /\b(Includes?|Depends on|Requires?) https:\/\/git\/(.*?)\/(.*?)\/pull\/(\d+)/i;
const includePr2 = /\b(Includes?|Depends on|Requires?) (\w+)\/(\w+)#(\d+)\b/i;
allPrBodies.merge(existingIssueComments).merge(newIssueComments)
	.map(x => ({ id: x.id, match: includePr1.exec(x.body) || includePr2.exec(x.body) }))
	.filter(x => x.match)
	.map(x => ({ parent: x.id, child: `${x.match[2]}/${x.match[3]}/${x.match[4]}` }))
	.subscribe(x => state.addPullRequestDependency(x.parent, x.child), e => log.error(e));

// look for "Rebuild this" in new comments only
newIssueComments.subscribe(comment => {
	if (/rebuild this/i.test(comment.body))
		buildPullRequest(comment.id);
}, e => log.error(e));

// build all new or updated PRs
gitHubEvents.pull_request
	.filter(pr => pr.action === 'opened' || pr.action === 'reopened' || pr.action === 'synchronize')
	.pluck('pull_request')
	.map(mapGitHubPullRequest)
	.delaySubscription(1000) // feels hacky but we need state to have been updated
	.subscribe(pr => {
		buildPullRequest(pr.id);
	}, e => log.error(e));

var jenkinsNotifications = jenkinsEvents
	.do(job => log.debug(`Received ${job.build.phase} notification for ${job.name}`))
	.map(job => ({ job, buildData: activeBuilds.get(job.build.parameters.sha1) }))
	.filter(x => x.buildData)
	.do(x => log.debug(`Corresponding build config is ${x.buildData.config.id}`))
	.share();

// set 'pending' status (with link to build) when build starts
jenkinsNotifications
	.filter(x => x.job.build.phase === 'STARTED')
	.subscribe(x => {
		setStatus(x.buildData, `Jenkins: ${x.job.name}`, 'pending', 'Building with Jenkins', x.job.build.full_url);
		superagent.post(`${x.job.build.full_url}/submitDescription`)
			.type('form')
			.send({ description: x.buildData.pullRequests[0].title, Submit: 'Submit' })
			.end();
	}, e => log.error(e));

// set 'success' or 'failure' status when build finishes
jenkinsNotifications
	.filter(x => x.job.build.phase === 'COMPLETED')
	.do(x => log.info(`Job ${x.job.name} status is ${x.job.build.status}`))
	.subscribe(x => {
		setStatus(x.buildData,
			`Jenkins: ${x.job.name}`,
			x.job.build.status === 'SUCCESS' ? 'success' : 'failure',
			`Jenkins build status: ${x.job.build.status}`,
			x.job.build.full_url);
		x.buildData.jobCount--;
		if (x.buildData.jobCount === 0) {
			x.buildData.github.git.refs(`heads/${x.buildData.buildBranchName}`).remove()
				.then(success => log.debug(`Branch ${x.buildData.config.repo.user}/${x.buildData.config.repo.repo}/${x.buildData.buildBranchName} was ${success ? '' : 'not '}deleted`));
			for (const sb of x.buildData.submoduleBranches) {
				github.repos(sb.user, sb.repo).git.refs(`heads/${sb.branch}`).remove()
					.then(success => log.debug(`Branch ${sb.user}/${sb.repo}/${sb.branch} was ${success ? '' : 'not '}deleted`));
			}
		}
	}, e => log.error(e));

let started = false;
export function start(port, gitHubUrl, gitHubToken) {
	if (!port)
		throw new Error('port must be specified');
	if (!gitHubUrl)
		throw new Error('gitHubUrl must be specified');
	if (!gitHubToken)
		throw new Error('gitHubToken must be specified');
	if (started)
		throw new Error('Server is already started');
	started = true;
	log.info(`Starting server v${version} on port ${port}`);

	github = new octokat({
		token: gitHubToken,
		rootURL: gitHubUrl
	});

	pushedLeeroyConfigs.subscribe(state.addBuildConfig, e => log.error(e));

	app.listen(port);
}
