const prototype = { 

};

function create(base, head, number, title) {
	return Object.create(prototype, {
		base: { value: base },
		head: { value: head },
		number: { value: number },
		title: { value: title },
		includes: { value: [] },
		id: { get: function() { return `${this.base.user}/${this.base.repo}/${this.number}`; } }
	});
}

exports.create = create;
