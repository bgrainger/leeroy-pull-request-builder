'use strict';

const log = require('./logger');
const rx = require('rx');

const allBuilds = [ ];
const allPrs = { };
const prIncludes = { };
const prIncluded = { };
const submoduleRepos = new Set();
const submoduleBuilds = { };
const watchedRepos = new rx.Subject();

function addBuildConfig(buildConfig) {
	log.debug(`Adding Leeroy config ${buildConfig.id} for ${buildConfig.repo.id}`);
	
	allBuilds.push(buildConfig);
	
	for (const submodule in buildConfig.submodules) {
		const id = `${submodule}/${buildConfig.submodules[submodule]}`;
		submoduleBuilds[id] = submoduleBuilds[id] || [];
		submoduleBuilds[id].push(buildConfig);

		if (!submoduleRepos.has(submodule)) {
			submoduleRepos.add(submodule);
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
}

function walkGraph(edges, id) {
	const results = new Set();
	const queue = [ id ];
	while (queue.length) {
		const nextId = queue.shift();
		results.add(nextId);
		queue.push(...(edges[nextId] || []));
	}
	return results;
}

function getIncludedPrs(prId) {
	return walkGraph(prIncludes, prId).values();
}

function getIncludingPrs(prId) {
	const including = walkGraph(prIncluded, prId);
	including.delete(prId);
	return including.values();
}

function getPr(prId) {
	return allPrs[prId];
}

function getPrBuilds(pr) {
	return submoduleBuilds[pr.base.id];
}

exports.addBuildConfig = addBuildConfig;
exports.addPullRequest = addPullRequest;
exports.addPullRequestDependency = addPullRequestDependency;
exports.getIncludedPrs = getIncludedPrs;
exports.getIncludingPrs = getIncludingPrs;
exports.getPr = getPr;
exports.getPrBuilds = getPrBuilds;
exports.watchedRepos = watchedRepos;
