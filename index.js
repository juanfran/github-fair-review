import { Octokit } from '@octokit/rest';
import { exec } from 'child_process';
import { formatDistance } from 'date-fns';
import config from './config.json' with { type: 'json' };

/** @type {{[key: number]: any}} */
const reviews = {};

const testMode = process.argv.includes('--test');
const windowArg = process.argv.find((arg) => arg.startsWith('--window='));
const prWindow = windowArg ? Number(windowArg.split('=')[1]) : 100;

if (!Number.isInteger(prWindow) || prWindow < 1) {
  console.error(`ERROR: invalid ${windowArg}, it must be a positive integer.`);
  process.exit(1);
}

/**
 * @type {string[]}
 */
const availableUsers = config.users.filter((user) => {
  return user.enabled;
});
const fronts = availableUsers.map((user) => user.github);

/**
 * @param {string} msg - Message to send to Mattermost.
 * @returns {void}
 * @description Sends a message to Mattermost.
 */
function sendMattermostMessage(msg) {
  console.log(`Sending Mattermost message: ${msg}`);

  if (testMode || !config.mattermostHook) {
    return;
  }

  const command = `curl -i -X POST -H 'Content-Type: application/json' -d '{"text": "${msg}"}' ${config.mattermostHook}`;
  exec(command);
}

/**
 * @param {string[]} names - An array of GitHub usernames.
 * @returns {string[]} - An array of Mattermost user mentions.
 */
function getMattermostNames(names) {
  return names.map((name) => {
    const user = availableUsers.find((user) => {
      return user.github === name;
    });

    return user.mention;
  });
}

/**
 * @param {string[]} authorsLog - Array of GitHub usernames.
 * @param {string[]} exclude - GitHub usernames to exclude.
 * @returns {{position: number, name: string} | null} - Object with position and name of the oldest user or null.
 */
function getOlder(authorsLog, exclude) {
  let older = {
    position: -1,
    name: '',
  };

  fronts
    .filter((front) => !exclude.includes(front))
    .forEach((front) => {
      const lastPr = [...authorsLog, ...fronts].indexOf(front);

      if (lastPr > older.position) {
        older = {
          position: lastPr,
          name: front,
        };
      }
    });

  if (older.name === '') {
    return null;
  }

  return older;
}

/**
 * @param {any} pr - Pull request object.
 * @returns {string[]} - Array of GitHub usernames.
 */
function getPrAssign(pr) {
  const users = [];

  if (pr.assignee) {
    users.push(pr.assignee.login);
  }

  if (pr.requested_reviewers.length) {
    pr.requested_reviewers.forEach((reviewer) => {
      users.push(reviewer.login);
    });
  }

  if (reviews[pr.number]) {
    reviews[pr.number].data.forEach((review) => {
      users.push(review.user.login);
    });
  }

  return [...new Set(users)].filter((user) => user !== pr.user.login);
}

async function run() {
  console.log('Starting...');

  const octokit = new Octokit({
    auth: config.auth,
  });

  console.log('Fetching pull requests...');
  const allPrs = { data: [] };
  const perPage = Math.min(prWindow, 100);
  for (let page = 1; allPrs.data.length < prWindow; page++) {
    const prsPage = await octokit.rest.pulls.list({
      owner: config.github.owner,
      repo: config.github.repo,
      state: 'all',
      per_page: perPage,
      page,
      sort: 'created',
      direction: 'desc',
    });
    allPrs.data.push(...prsPage.data);
    if (prsPage.data.length < perPage) {
      break;
    }
  }
  allPrs.data = allPrs.data.slice(0, prWindow);

  console.log('Filtering valid pull requests...');
  const validPrs = allPrs.data.filter((pr) => {
    return fronts.includes(pr.user.login) && !pr.draft;
  });

  for (let i = 0; i < validPrs.length; i += 10) {
    await Promise.all(
      validPrs.slice(i, i + 10).map(async (pr) => {
        reviews[pr.number] = await octokit.rest.pulls.listReviews({
          owner: config.github.owner,
          repo: config.github.repo,
          pull_number: pr.number,
        });
      }),
    );
  }

  const pendingPrs = validPrs.filter((pr) => {
    return (
      pr.state === 'open' &&
      !pr.assignee &&
      !pr.requested_reviewers.length &&
      !pr.title.includes('WIP')
    );
  });

  if (!pendingPrs.length) {
    console.log('No pending pull requests found.');
    return;
  }

  const inProgressPrs = validPrs.filter((pr) => {
    return pr.state === 'open' && !pr.title.includes('WIP');
  });

  console.log('Building reviewer activity log...');
  // Each contribution is timestamped by when the review actually happened
  // (review.submitted_at), not by the PR creation date. Ordering by creation
  // date is wrong: a late review of an old PR would make the reviewer look
  // overdue even though they just reviewed.
  const contributions = [];

  for (const pr of validPrs) {
    if (pr.assignee?.login) {
      contributions.push({ user: pr.assignee.login, at: pr.updated_at });
    }

    if (pr.requested_reviewers?.length) {
      pr.requested_reviewers.forEach((requested_reviewer) => {
        contributions.push({ user: requested_reviewer.login, at: pr.updated_at });
      });
    }

    reviews[pr.number].data.forEach((review) => {
      if (pr.user.login !== review.user.login) {
        contributions.push({
          user: review.user.login,
          at: review.submitted_at ?? pr.updated_at,
        });
      }
    });
  }

  // Newest activity first, so getOlder's indexOf picks each user's most
  // recent review and the least-recent reviewer wins.
  let authors = contributions
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .map((contribution) => contribution.user)
    .filter((author) => fronts.includes(author));

  const assignedIds = [];
  const messages = [];

  console.log('Assigning reviewers...');
  pendingPrs.forEach((pr) => {
    const tagUsers = pr.labels.flatMap((label) => config.tagLists?.[label.name] ?? []);

    if (config.tagLists && !tagUsers.length) {
      console.warn(
        `WARNING: PR ${pr.number} by ${pr.user.login} skipped, no matching label ${pr.html_url}`,
      );
      return;
    }

    const excludeByTag = tagUsers.length
      ? fronts.filter((front) => !tagUsers.includes(front))
      : [];
    const user = getOlder(authors, [
      pr.user.login,
      ...config.excludeFromReview,
      ...excludeByTag,
    ]);

    if (user) {
      authors = [user.name, ...authors];
      const userName = getMattermostNames([user.name])[0];
      let msg = `PR ${pr.number} by ${pr.user.login} assigned to ${userName} ${pr.html_url}`;

      if (testMode && config.tagLists) {
        const matchedLabels = pr.labels
          .map((label) => label.name)
          .filter((name) => config.tagLists?.[name]?.length);
        msg += ` (labels: ${matchedLabels.join(', ')})`;
      }

      if (!testMode) {
        console.log(`Assigning assignee for PR ${pr.number}...`);
        octokit.rest.issues.addAssignees({
          owner: config.github.owner,
          repo: config.github.repo,
          issue_number: pr.number,
          assignees: [user.name],
        });
      }

      assignedIds.push(pr.number);

      messages.push(msg);
    } else {
      console.warn(
        `WARNING: PR ${pr.number} by ${pr.user.login} skipped, no available reviewer ${pr.html_url}`,
      );
    }
  });

  if (testMode) {
    console.log('Test mode: nothing assigned, no message sent.');
    console.log(messages.join('\n'));
    return;
  }

  inProgressPrs
    .filter((pr) => {
      const isApproved = !!reviews[pr.number].data.find(
        (it) => it.state === 'APPROVED',
      );
      return !isApproved;
    })
    .forEach((pr) => {
      if (!assignedIds.includes(pr.number)) {
        const users = getPrAssign(pr);
        const now = new Date();
        const prDate = new Date(pr.created_at);
        const distance = formatDistance(prDate, now, { addSuffix: true });

        const userNames = getMattermostNames(users);

        const msg = `${pr.html_url} assigned to ${userNames.join(
          ', ',
        )}, open ${distance}`;

        messages.push(msg);
      }
    });

  if (messages.length) {
    sendMattermostMessage(messages.join('\\n'));
  }
}

run();
