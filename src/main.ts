import * as core from '@actions/core';
import * as github from '@actions/github';
import fetch from 'node-fetch';
const TICKET_NAMED_GROUP = 'ticket';

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

function getTicketFrom(text: string, regex: RegExp, errorCode: string): string {
  core.info(
    `Matching regex "${regex.source}" with "${regex.flags}" flags against: "${text}"`
  );
  const match = regex.exec(text);
  if (!match) {
    const msg = `Regex "${regex.source}" with "${regex.flags}" flags doesn't match: "${text}"`;
    core.setOutput('error', errorCode);
    throw new Error(msg);
  }

  if (!match.groups || !match.groups[TICKET_NAMED_GROUP]) {
    core.setOutput('error', errorCode);
    throw new Error(
      `The tickets key (${TICKET_NAMED_GROUP}) is missing from ${regex.source}`
    );
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
    core.setOutput('error', 'unknown-jira-ticket');
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
    core.setOutput('error', 'ticket-missing-in-body');
    throw new Error(`PR body deosn't contain: "${text}"`);
  }
}

function getInput(text: string) {
  return core.getInput(text, {required: true});
}

async function runAction() {
  const atlassianToken = getInput('atlassian-token'),
    atlassianDomain = getInput('atlassian-domain'),
    titleRegex = new RegExp(getInput('title-regex'), 'g'),
    branchNameRegex = new RegExp(getInput('branch-name-regex'), 'g');
  return run(atlassianToken, atlassianDomain, titleRegex, branchNameRegex);
}

async function run(
  atlassianToken: string,
  atlassianDomain: string,
  titleRegex: RegExp,
  branchNameRegex: RegExp
) {
  try {
    core.info('Extracting JIRA tickets from title...');
    const ticket = getTicketFrom(
      github.context!.payload!.pull_request!.title,
      titleRegex,
      'invalid-title'
    );
    core.setOutput('ticket', ticket);

    core.info('Extracting JIRA tickets from branch name...');
    const branchTicket = getTicketFrom(
      getBranchName(),
      branchNameRegex,
      'invalid-branch-name'
    );

    core.info('Verifying branch tickets and PR ticket are identical...');
    if (ticket !== branchTicket) {
      core.setOutput('error', 'branch-ticket-differs-title-ticket');
      throw new Error(
        `branch ticket (${branchTicket}) != title ticket (${ticket})`
      );
    }

    core.info(`Verifying that ticket ${ticket} exists in JIRA`);
    await verifyTicketExistsInJIRA(ticket, atlassianDomain, atlassianToken);

    core.info(`Verifying that ticket ${ticket} exists in ticket body`);
    const body: string = github.context!.payload!.pull_request!.body ?? '';
    verifyTicketExistBody(body, ticket.toUpperCase());
  } catch (error) {
    core.setFailed((error as Error).message);
  }
}

runAction();
