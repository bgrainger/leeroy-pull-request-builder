const prototype = {
	
};

function create(user, repo, branch) {
	return Object.create(prototype, {
		user: { value: user },
		repo: { value: repo },
		branch: { value: branch }
	});
}

exports.create = create;