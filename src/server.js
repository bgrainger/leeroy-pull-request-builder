const bodyParser = require('body-parser');
const express = require('express');
const rx = require('rx');

var server = {
	gitHubWebHookHandler: function gitHubWebHookHandler(req, res) {
		const gitHubEvent = req.headers['x-github-event'];
		const subject = this.github[gitHubEvent];
		if (subject) {
			subject.onNext(req.body);
			res.status(204).send();
		} else {
			res.status(400).send();
		}
	},
	
	jenkinsWebHookHandler: function jenkinsWebHookHandler(req, res) {
		this.builds.onNext(req.body);
		res.status(204).send();
	}
}

function startServer(port) {
	var that = Object.create(server);

	that.app = express();
	that.app.use(bodyParser.json());
	that.app.listen(port);
	
	that.github = {
		'issue_comment': new rx.Subject(),
		'push': new rx.Subject(),
		'pull_request': new rx.Subject(),
		'ping': new rx.Subject()
	};
	
	that.builds =new rx.Subject(); 
	
	that.app.post('/event_handler', that.gitHubWebHookHandler);
	that.app.post('/jenkins', that.jenkinsWebHookHandler);
	
	return that;
}

exports.start = startServer;
