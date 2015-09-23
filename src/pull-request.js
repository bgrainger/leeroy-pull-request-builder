export function create(base, head, number, title) {
	return Object.create({}, {
		base: { value: base },
		head: { value: head },
		number: { value: number },
		title: { value: title },
		id: { get() { return `${this.base.user}/${this.base.repo}/${this.number}`; } }
	});
}
