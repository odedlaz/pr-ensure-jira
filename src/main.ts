
import * as core from '@actions/core';
import * as github from '@actions/github';
import fetch from 'node-fetch';

function getBranchName(): string {
  const head_ref = process.env.GITHUB_HEAD_REF;
  if (head_ref && github.context!.eventName === 'pull_request') {
      return head_ref;
  }

  // Other events where we have to extract branch from the ref
  // Ref example: refs/heads/master, refs/tags/X
  const branchParts = github.context!.ref.split('/');
  return branchParts.slice(2).join('/');
}

async function run() {
  try {
    const
      githubToken = core.getInput('github-token', { required: true }),
      atlassianToken = core.getInput('atlassian-token', { required: true }),
      atlassianDomain = core.getInput('atlassian-domain', { required: true }),
      titleRegex = new RegExp(core.getInput('ticket-regex', { required: true }),
        core.getInput('title-regex-flags') || 'g'),
      title = github.context!.payload!.pull_request!.title,
      body = github.context!.payload!.pull_request!.body ?? "";

    core.info(`Checking "${titleRegex.source}" with "${titleRegex.flags}" flags against the PR title: "${title}"`);
    let match = titleRegex.exec(title)
    if (!match) {
      core.setFailed("The PR title is missing a JIRA ticket");
      return;
    }

    core.info(`The PR title matches!`);

    if (!match.groups || !match.groups['ticket']) {
      core.setFailed("The ticket key is missing from the ticket-regex");
      return;
    }

    const ticket = match.groups['ticket'];
    core.info(`Verifying that ticket ${ticket} exists in JIRA`);

    const response = await fetch(`https://${atlassianDomain}/rest/api/3/issue/${ticket}`, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${Buffer.from(atlassianToken).toString('base64')}`,
        'Accept': 'application/json'
      }
    });

    if (response.status != 200) {
      const data = await response.text()
      core.setFailed(`Unknown JIRA ticket: ${ticket}: ${data}`);
      return;
    }
    core.info(`JIRA ticket ${ticket} found`);

    const branchNameRegexText = core.getInput('branch-name-regex')
    if (branchNameRegexText) {
      const branchNameRegex = RegExp(branchNameRegexText, "g"),
        branchName = getBranchName(),
        m = branchNameRegex.exec(branchName);

      core.info(`Verifying branch name ${branchName} conforms to regex: ${branchNameRegex.source}`);
      if (!m || !m.groups || !m.groups['ticket']) {
        core.error(`branch name ${branchName} doesn't conform to regex: ${branchNameRegex}`);
        core.setFailed("The ticket key is missing from branch name");
        return;
      }

      core.info(`Done. Verifying branch ticket and PR ticket names are identical...`);
      const branchTicket = m.groups['ticket'];
      if (branchTicket.toUpperCase() != ticket.toUpperCase()) {
        core.error(`branch ticket name ${branchTicket} != title ticket name ${ticket}`);
        core.setFailed("ticket from branch name != ticket from PR title");
        return;
      }
    }

    const client: github.GitHub = new github.GitHub(githubToken);
    const pr = github.context.issue;

    const ticketRef = `[${ticket}](https://${atlassianDomain}/browse/${ticket})`;
    if (body.includes(ticketRef)) {
      core.debug(`PR body already contains ${ticket} url`);
      return;
    }


    const newBody = body.replace(ticket, ticketRef);
    if (newBody == body) {
      // body hasn't changed, no need to issue an update
      return;
    }
    
    core.info(`JIRA ticket ${ticket} exists in PR body, replacing with URL`);
    client.pulls.update({
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      body: newBody
    });
    core.info("done!");
  } catch (error) {
    core.error(error.message);
    core.setFailed(error.message);
  }
}

run();