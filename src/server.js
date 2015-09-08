const bodyParser = require('body-parser');
const express = require('express');
const rx = require('rx');

let app = express();
app.use(bodyParser.json());

let gitHubSubjects = {
	'issue_comment': new rx.Subject(),
	'push': new rx.Subject(),
	'pull_request': new rx.Subject(),
	'ping': new rx.Subject()
};

let jenkinsSubject =new rx.Subject(); 

function gitHubWebHookHandler(req, res) {
	const gitHubEvent = req.headers['x-github-event'];
	const subject = gitHubSubjects[gitHubEvent];
	if (subject) {
		subject.onNext(req.body);
		res.status(204).send();
	} else {
		res.status(400).send();
	}
};

function jenkinsWebHookHandler(req, res) {
	this.jenkinsSubject.onNext(req.body);
	res.status(204).send();
};

app.get('/', (req, res) => res.send('leeroy-pull-request-builder'));
app.post('/event_handler', gitHubWebHookHandler);
app.post('/jenkins', jenkinsWebHookHandler);

let started = false;

function startServer(port) {
	if (started)
		throw new Error('Server is already started.');
	started = true;
	app.listen(port);	
}

exports.github = gitHubSubjects;
exports.jenkins = jenkinsSubject;
exports.start = startServer;
