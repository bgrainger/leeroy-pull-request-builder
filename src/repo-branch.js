const prototype = {
	
};

function create(user, repo, branch) {
	return Object.create(prototype, {
		user: { value: user },
		repo: { value: repo },
		branch: { value: branch },
		id: { get: function() { return `${this.user}/${this.repo}/${this.branch}`; } }
	});
}

exports.create = create;