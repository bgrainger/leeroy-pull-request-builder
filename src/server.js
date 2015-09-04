const bodyParser = require('body-parser');
const express = require('express');
const rx = require('rx');

var server = {
	gitHubWebHookHandler: function gitHubWebHookHandler(req, res) {
		const gitHubEvent = req.headers['x-github-event'];
		const subject = this.public.github[gitHubEvent];
		if (subject) {
			subject.onNext(req.body);
			res.status(204).send();
		} else {
			res.status(400).send();
		}
	},
	
	jenkinsWebHookHandler: function jenkinsWebHookHandler(req, res) {
		this.public.jenkins.onNext(req.body);
		res.status(204).send();
	},
	
	start: function start(port) {
		this.public = {
			app: express(),
			github: {
				'issue_comment': new rx.Subject(),
				'push': new rx.Subject(),
				'pull_request': new rx.Subject(),
				'ping': new rx.Subject()
			},
			jenkins: new rx.Subject()
		};
		
		var app = this.public.app;
		app.use(bodyParser.json());
		app.listen(port);
		
		app.post('/event_handler', this.gitHubWebHookHandler);
		app.post('/jenkins', this.jenkinsWebHookHandler);
	}
}

exports.startServer = function startServer(port) {
	var srv = Object.create(server);
	srv.start(port);
	return srv.public;
}
