const prototype = {
	
};

function create(repo, jobs, submodules) {
	return Object.create(prototype, {
		repo: { value: repo },
		jobs: { value: jobs },
		submodules: { value: submodules }
	});
}

exports.create = create;
