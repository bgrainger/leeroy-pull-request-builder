const log = require('./logger');
const pullRequest = require('./pull-request');
const repoBranch = require('./repo-branch');

var allBuilds = [ ];
var allPrs = { };
var submoduleRepos = { };

const buildRepoUrl = /^git@git:([^/]+)\/([^.]+).git$/;

function addLeeroyConfig(leeroyConfig) {
	log.debug(`Adding Leeroy config for ${leeroyConfig.repoUrl}`);
	let [, user, repo] = buildRepoUrl.exec(leeroyConfig.repoUrl) || [];
	var build = {
		repo : {
			user,
			repo,
			branch: leeroyConfig.branch || 'master'
		},
		jobs : leeroyConfig.pullRequestBuildUrls.map(function (buildUrl) {
			var match = /\/job\/([^/]+)\/buildWithParameters/.exec(buildUrl);
			return {
				name: match && match[1],
				url: buildUrl
			};
		})
			.filter(job => job.name ? true : false)
	};
	
	allBuilds.push(build);
	
	for (var submodule in leeroyConfig.submodules) {
		submoduleRepos[submodule] = submoduleRepos[submodule] || { };
		var branch = leeroyConfig.submodules[submodule];
		submoduleRepos[submodule][branch] = submoduleRepos[submodule][branch] || [ ];
		submoduleRepos[submodule][branch].push(build);
    }
}

function addPullRequest(pr) {
	allPrs[pr.id] = pr;
	log.debug(`Added ${pr.id}.`);
}

function getReposToWatch() {
	return Object.keys(submoduleRepos);
}

exports.addLeeroyConfig = addLeeroyConfig;
exports.addPullRequest = addPullRequest;
exports.getReposToWatch = getReposToWatch;
