'use strict';

function create(user, repo, branch) {
	return Object.create({}, {
		user: { value: user },
		repo: { value: repo },
		branch: { value: branch },
		id: { get() { return `${this.user}/${this.repo}/${this.branch}`; } }
	});
}

exports.create = create;