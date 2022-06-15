import * as core from '@actions/core';
import * as github from '@actions/github';
import fetch from 'node-fetch';
const TICKET_NAMED_GROUP = 'ticket';

class CommentableError extends Error {
  comment: string;
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

function getTicketFrom(text: string, regex: RegExp, errorComment?: string): string {
  core.info(
    `Matching regex "${regex.source}" with "${regex.flags}" flags against: "${text}"`
  );
  const match = regex.exec(text);
  if (!match) {
    const msg = `Regex "${regex.source}" with "${regex.flags}" flags doesn't match: "${text}"`;
    throw errorComment
      ? new CommentableError(msg, errorComment.replace('%text%', `${text}`))
      : new Error(msg);
  }

  if (!match.groups || !match.groups[TICKET_NAMED_GROUP]) {
    throw new Error(`The tickets key (${TICKET_NAMED_GROUP}) is missing from ${regex.source}`);
  }

  return match.groups[TICKET_NAMED_GROUP].toUpperCase();
}

async function verifyTicketExistsInJIRA(
  ticket: string,
  atlassianDomain: string,
  atlassianToken: string
) {
  const response = await fetch(
    `https://${atlassianDomain}/rest/api/3/issue/${ticket}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Basic ${Buffer.from(atlassianToken).toString(
          'base64'
        )}`,
        Accept: 'application/json'
      }
    }
  );

  if (response.status == 200) {
    core.info(`JIRA ticket ${ticket} found`);
    return;
  }

  if (response.status == 404) {
    throw new Error(`Unknown JIRA ticket: ${ticket}`);
  }

  throw new Error(
    `Unhandled response from atlassian: ${await response.text()}`
  );
}

function verifyTicketExistBody(body: string, ticket: string) {
  const prefix = core.getInput('body-ticket-prefix', {required: false});
  if (!body.includes(prefix)) {
    return;
  }

  const text = `${prefix} ${ticket.toUpperCase()}`;
  if (!body.includes(text)) {
    throw new Error(`PR body deosn't contain: "${text}"`);
  }
}
async function runAction() {
  const atlassianToken = core.getInput('atlassian-token', {required: true}),
    atlassianDomain = core.getInput('atlassian-domain', {required: true}),
    titleRegex = new RegExp(core.getInput('title-regex', {required: true}), 'g'),
    titleComment = core.getInput('title-comment', {required: false}),
    branchNameRegex = new RegExp(core.getInput('branch-name-regex', {required: true}), 'g'),
    branchNameComment = core.getInput('branch-name-comment', {required: false});

  return run(
    atlassianToken,
    atlassianDomain,
    titleRegex,
    branchNameRegex,
    titleComment,
    branchNameComment
  );
}

async function run(
  atlassianToken: string,
  atlassianDomain: string,
  titleRegex: RegExp,
  branchNameRegex: RegExp,
  titleComment?: string,
  branchNameComment?: string
) {
  const githubToken = core.getInput('github-token', {required: true});
  const client: github.GitHub = new github.GitHub(githubToken);
  const pr = github.context.issue;

  try {
    core.info('Extracting JIRA tickets from title...');
    const ticket = getTicketFrom(
      github.context!.payload!.pull_request!.title,
      titleRegex,
      titleComment
    );

    core.info('Extracting JIRA tickets from branch name...');
    const branchTicket = getTicketFrom(
      getBranchName(),
      branchNameRegex,
      branchNameComment
    );

    core.info('Verifying branch tickets and PR ticket are identical...');
    if (ticket !== branchTicket) {
      throw new Error(
        `branch ticket (${branchTicket}) != title ticket (${ticket})`
      );
    }

    const body: string = github.context!.payload!.pull_request!.body ?? '';

    core.info(`Verifying that ticket ${ticket} exists in JIRA`);
    await verifyTicketExistsInJIRA(ticket, atlassianDomain, atlassianToken);
    verifyTicketExistBody(body, ticket.toUpperCase());
  } catch (error) {
    core.setFailed((error as Error).message);
    if (error instanceof CommentableError) {
      const comment = (error as CommentableError).comment;
      await client.pulls.createReview({
        owner: pr.owner,
        repo: pr.repo,
        pull_number: pr.number,
        body: comment,
        event: 'COMMENT'
      });
      core.setFailed(comment);
    }
  }
}

runAction();
