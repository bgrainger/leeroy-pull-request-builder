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
		this.jenkins.onNext(req.body);
		res.status(204).send();
	},
	
	start: function start(port) {
		this.app.use(bodyParser.json());
		this.app.listen(port);
		
		this.github = {
			'issue_comment': new rx.Subject(),
			'push': new rx.Subject(),
			'pull_request': new rx.Subject(),
			'ping': new rx.Subject()
		};
		
		this.jenkins =new rx.Subject(); 
		
		this.app.post('/event_handler', this.gitHubWebHookHandler);
		this.app.post('/jenkins', this.jenkinsWebHookHandler);
	}
}

exports.startServer = function startServer(port) {
	var that = Object.create(server);
	that.start(port);	
	return that;
}
