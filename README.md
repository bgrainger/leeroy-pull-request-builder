# Leeroy Pull Request Builder

Builds pull requests for [Leeroy](https://github.com/LogosBible/Leeroy)-based builds.

## How to Use

### Jenkins

Create a new Jenkins job, based on your existing job, with the suffix "-PR" appended.

Add a Notification Endpoint:
* Format: JSON
* Protocol: HTTP
* Event: All Events
* URL: http://leeroy-webhook.lrscorp.net:4001/jenkins

Set "This build is parameterized". Add a string parameter named `sha1` (no default value).

Under Source Code Management > Git, set "Branches to build:" to `${sha1}`

Review any post-build steps left over from copying the existing Jenkins job, and delete
the unnecessary ones (which may be all of them). 

### GitHub Enterprise

At https://git/Logos/YourRepoName/settings, choose "Webhooks and Services".

Click "Add Webhook":
* Payload URL: http://leeroy-webhook.lrscorp.net:4001/event_handler
* Content type: application/json
* Secret: (blank)
* Let me select individual events: Pull Request

Click "Add webhook"

### Leeroy

Edit your Leeroy config file and add:

```
"pullRequestBuildUrls": [ 
	"http://jenkins/job/YourJobName-PR/buildWithParameters"  
], 
```

## Requirements

* [GitHub Enterprise](https://enterprise.github.com/)
* [Jenkins](http://jenkins-ci.org/)
* [Jenkins Notification Plugin](https://wiki.jenkins-ci.org/display/JENKINS/Notification+Plugin)
* [NodeJS](https://nodejs.org/)

## Installation

### GitHub Enterprise

Add a webhook to https://git/Build/Configuration that sends push events to
http://leeroy-webhook.lrscorp.net:4001/event_handler.

In GitHub Enterprise, create an API token for the user who will update the PR status:
https://git/settings/tokens/new
* Token description: leeroy-pull-request-builder
* Select scopes: repo 

Save the token in a safe place.

### Server

Apply the `leeroy-pull-request-builder_server` puppet class to the node and run
`puppet apply -t`.

To restart the service, run `svcadm restart leeroy-pull-request-builder`.

### Deployment

Add a "deploy" git remote: `git remote add deploy ssh://desk-dev-util01.lrscorp.net/usr/local/src/leeroy-pull-request-builder.git`

To deploy the code: `git push deploy master`
