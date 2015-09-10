const log = require('./logger');
const pullRequest = require('./pull-request');
const repoBranch = require('./repo-branch');
const rx = require('rx');

const allBuilds = [ ];
const allPrs = { };
const prIncludes = { };
const prIncluded = { };
const submoduleRepos = { };
const submoduleBuilds = { };
const watchedRepos = new rx.Subject();

function addBuildConfig(buildConfig) {
	log.debug(`Adding Leeroy config for ${buildConfig.repo.id}`);
	
	allBuilds.push(buildConfig);
	
	for (let submodule in buildConfig.submodules) {
		const id = `${submodule}/${buildConfig.submodules[submodule]}`;
		submoduleBuilds[id] = submoduleBuilds[id] || [];
		submoduleBuilds[id].push(buildConfig);

		if (!submoduleRepos[submodule]) {
			submoduleRepos[submodule] = true;
			watchedRepos.onNext(submodule);
		}
    }
}

function addPullRequest(pr) {
	if (!allPrs[pr.id])
		allPrs[pr.id] = pr;
	else
		pr = allPrs[pr.id];
	log.debug(`Added ${pr.id}.`);
	return pr;
}

function addPullRequestDependency(parent, child) {
	log.info(`Adding link from ${parent} to ${child}`);
	prIncludes[parent] = prIncludes[parent] || [];
	prIncludes[parent].push(child);
	prIncluded[child] = prIncluded[child] || [];
	prIncluded[child].push(parent);
};

exports.addBuildConfig = addBuildConfig;
exports.addPullRequest = addPullRequest;
exports.addPullRequestDependency = addPullRequestDependency;
exports.watchedRepos = watchedRepos;
