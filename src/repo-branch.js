export function create(user, repo, branch) {
	return Object.create({
		toString() { return this.id; }
	}, {
		user: { value: user },
		repo: { value: repo },
		branch: { value: branch },
		id: { get() { return `${this.user}/${this.repo}/${this.branch}`; } }
	});
}