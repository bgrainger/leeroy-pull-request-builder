const log = require('./logger');
const pullRequest = require('./pull-request');
const repoBranch = require('./repo-branch');

var allBuilds = [ ];
var allPrs = { };
var submoduleRepos = { };
var submoduleBuilds = { };


function addBuildConfig(buildConfig) {
	log.debug(`Adding Leeroy config for ${buildConfig.repo.id}`);
	
	allBuilds.push(buildConfig);
	
	for (var submodule in buildConfig.submodules) {
		submoduleRepos[submodule] = true;

		var id = `${submodule}/${buildConfig.submodules[submodule]}`;
		submoduleBuilds[id] = submoduleBuilds[id] || [];
		submoduleBuilds[id].push(buildConfig);
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

function getReposToWatch() {
	return Object.keys(submoduleRepos);
}

exports.addBuildConfig = addBuildConfig;
exports.addPullRequest = addPullRequest;
exports.getReposToWatch = getReposToWatch;
