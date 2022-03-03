
import * as core from '@actions/core';
import * as github from '@actions/github';
import fetch from 'node-fetch';
const TICKETS_NAMED_GROUP = "tickets"

class CommentableError extends Error {
  /**
   *
   */
  comment: string
  constructor(message: string, comment: string) {
    super(message);
    this.comment = comment;
  }

}

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

function getTicketsFrom(text: string, regex: RegExp, delimiter: string, errorComment?: string): Set<string> {
  core.info(`Matching regex "${regex.source}" with "${regex.flags}" flags against: "${text}"`);
  const match = regex.exec(text)
  if (!match) {
    const msg = `Regex "${regex.source}" with "${regex.flags}" flags doesn't match: "${text}"`;
    throw (errorComment ? new CommentableError(msg, errorComment.replace("%text%", `${text}`)) : new Error(msg));
  }

  if (!match.groups || !match.groups[TICKETS_NAMED_GROUP]) {
    throw new Error(`The tickets key (${TICKETS_NAMED_GROUP}) is missing from ${regex.source}`);
  }

  return new Set(match.groups[TICKETS_NAMED_GROUP].split(delimiter).map(x => x.toUpperCase()));
}

async function verifyTicketExistsInJIRA(ticket: string, atlassianDomain: string, atlassianToken: string) {
  const response = await fetch(`https://${atlassianDomain}/rest/api/3/issue/${ticket}`, {
    method: 'GET',
    headers: {
      'Authorization': `Basic ${Buffer.from(atlassianToken).toString('base64')}`,
      'Accept': 'application/json'
    }
  });

  if (response.status == 200) {
    core.info(`JIRA ticket ${ticket} found`);
    return;
  }

  if (response.status == 404) {
    throw new Error(`Unknown JIRA ticket: ${ticket}`);
  }

  throw new Error(`Unhandled response from atlassian: ${await response.text()}`);
}

function replaceRawTicketWithHyperlink(body: string, ticket: string, atlassianDomain: string) {
  const ticketRef = `[${ticket}](https://${atlassianDomain}/browse/${ticket})`;
  if (body.includes(ticketRef)) {
    core.debug(`PR body already contains ${ticket} url`);
    return body;
  }

  core.info(`JIRA ticket ${ticket} exists in PR body, replacing with URL (if applicable)...`);
  return body.replace(ticket, ticketRef);
}

async function run() {
  const githubToken = core.getInput('github-token', { required: true });
  const client: github.GitHub = new github.GitHub(githubToken);
  const pr = github.context.issue;

  try {
    const
      atlassianToken = core.getInput('atlassian-token', { required: true }),
      atlassianDomain = core.getInput('atlassian-domain', { required: true }),
      titleRegex = new RegExp(core.getInput('title-regex', { required: true }), 'g'),
      titleComment = core.getInput('title-comment', { required: false }),
      branchNameRegex = new RegExp(core.getInput('branch-name-regex', { required: true }), 'g'),
      branchNameComment = core.getInput('branch-name-comment', { required: false }),
      titleTicketDelimeter = core.getInput('title-ticket-delimiter', { required: true }),
      branchNameTicketDelimeter = core.getInput('branch-name-ticket-delimiter', { required: true });

    core.info("Extracting JIRA tickets from title...");
    const titleTickets = getTicketsFrom(github.context!.payload!.pull_request!.title, titleRegex, titleTicketDelimeter, titleComment);

    core.info("Extracting JIRA tickets from branch name...");
    const branchTickets = getTicketsFrom(getBranchName(), branchNameRegex, branchNameTicketDelimeter, branchNameComment);

    core.info("Verifying branch tickets and PR ticket are identical...");
    if ([...titleTickets].filter(ticket => !branchTickets.has(ticket)).length > 0 ||
      [...branchTickets].filter(ticket => !titleTickets.has(ticket)).length > 0) {
      throw new Error(`branch tickets (${Array.from(branchTickets).join(",")}) != title tickets (${Array.from(titleTickets).join(",")})`);
    }

    const originalBody = github.context!.payload!.pull_request!.body ?? "";
    let newBody = originalBody;

    for (let ticket of titleTickets) {
      core.info(`Verifying that ticket ${ticket} exists in JIRA`);
      await verifyTicketExistsInJIRA(ticket, atlassianDomain, atlassianToken);
      newBody = replaceRawTicketWithHyperlink(newBody, ticket, atlassianDomain);
    }

    if (newBody == originalBody) {
      core.debug("PR body hasn't changed, nothing else to do...");
      return;
    }

    client.pulls.update({
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      body: newBody
    });
  } catch (error) {
    if (error instanceof CommentableError) {
      client.pulls.createReview({
        owner: pr.owner,
        repo: pr.repo,
        pull_number: pr.number,
        body: (error as CommentableError).comment,
        event: 'COMMENT'
      });
    }
    core.setFailed((error as Error).message);
  }
}

run();
