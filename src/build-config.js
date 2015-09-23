export function create(id, repo, jobs, submodules) {
	return Object.create({}, {
		id: { value: id },
		repo: { value: repo },
		jobs: { value: jobs },
		submodules: { value: submodules }
	});
}
