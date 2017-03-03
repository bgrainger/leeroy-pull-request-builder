# Leeroy Pull Request Builder

Builds pull requests for [Leeroy](https://github.com/LogosBible/Leeroy)-based builds.

## How to Use

Once leeroy-pull-request-builder is set up (see [How to Configure](#how-to-configure) below),
pull requests opened against the configured repositories should automatically be built, and
push their status back to GitHub Enterprise.

### Force a Rebuild

To force a PR to be reintegrated, enter the text `rebuild this` as a comment on the PR.

### Build two PRs at once

If PR #123 in OrgA/RepoA requires PR #456 in OrgB/RepoB to build successfully, go to https://git/OrgA/RepoA/pull/123
and add a comment with the text `Requires OrgB/RepoB#456`. (You can include this text in
the description when you open a PR, or you can add it as a PR comment afterwards; however, you can't edit
the description of an existing PR to add this comment, because GitHub doesn't raise a notification for that
edit.)

You can also use the synonyms "Includes …" or "Depends on …".

## How to Configure

### Jenkins

Create a new Jenkins job, based on your existing job, with the suffix "-PR" appended.

Add a Notification Endpoint:
* Format: JSON
* Protocol: HTTP
* Event: All Events
* URL: http://leeroy-webhook.lrscorp.net:4000/jenkins

Set "This build is parameterized". Add a string parameter named `sha1` (no default value).

Under Source Code Management > Git, set "Branches to build:" to `${sha1}`

Review any post-build steps left over from copying the existing Jenkins job, and delete
the unnecessary ones (which may be all of them). 

### GitHub Enterprise

At https://git/Logos/YourRepoName/settings, choose "Webhooks and Services".

Click "Add Webhook":
* Payload URL: http://leeroy-webhook.lrscorp.net:4000/github
* Content type: application/json
* Secret: (blank)
* Let me select individual events: Pull Request, Issue Comment

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
http://leeroy-webhook.lrscorp.net:4000/github.

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
