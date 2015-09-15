'use strict';

const prototype = {
	
};

function create(id, repo, jobs, submodules) {
	return Object.create(prototype, {
		id: { value: id },
		repo: { value: repo },
		jobs: { value: jobs },
		submodules: { value: submodules }
	});
}

exports.create = create;
