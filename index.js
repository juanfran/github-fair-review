import { Octokit } from '@octokit/rest';
import { exec } from 'child_process';
import { formatDistance } from 'date-fns';
import config from './config.json' assert { type: 'json' };

/** @type {{[key: number]: any}} */
const reviews = {};

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
  if (!config.mattermostHook) {
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
  const octokit = new Octokit({
    auth: config.auth,
  });

  const allPrs = await octokit.rest.pulls.list({
    owner: config.github.owner,
    repo: config.github.repo,
    state: 'all',
    per_page: 20,
    page: 0,
    sort: 'created',
    direction: 'desc',
  });

  const validPrs = allPrs.data.filter((pr) => {
    return fronts.includes(pr.user.login) && !pr.draft;
  });

  for (const pr of validPrs) {
    const prReviews = await octokit.rest.pulls.listReviews({
      owner: config.github.owner,
      repo: config.github.repo,
      pull_number: pr.number,
    });

    reviews[pr.number] = prReviews;
  }

  let pendingPrs = validPrs.filter((pr) => {
    return (
      pr.state === 'open' &&
      !pr.assignee &&
      !pr.requested_reviewers.length &&
      !pr.title.includes('WIP')
    );
  });

  pendingPrs = pendingPrs.filter((pr) => {
    return !reviews[pr.number].data.length;
  });

  const inProgressPrs = validPrs.filter((pr) => {
    return pr.state === 'open' && !pr.title.includes('WIP');
  });

  let authors = [];

  for (const pr of validPrs) {
    const prAuthors = [];
    if (pr.assignee?.login) {
      prAuthors.push(pr.assignee?.login);
    }

    if (pr.requested_reviewers?.length) {
      pr.requested_reviewers.forEach((requested_reviewer) => {
        prAuthors.push(requested_reviewer.login);
      });
    }

    const prReviews = await octokit.rest.pulls.listReviews({
      owner: config.github.owner,
      repo: config.github.repo,
      pull_number: pr.number,
    });

    prReviews.data.forEach((review) => {
      if (pr.user.login !== review.user.login) {
        prAuthors.push(review.user.login);
      }
    });

    authors.push(...new Set(prAuthors));
  }

  authors = authors.filter((author) => {
    return fronts.includes(author);
  });

  const assignedIds = [];

  pendingPrs.forEach((pr) => {
    const user = getOlder(authors, [pr.user.login, ...config.excludeFromReview]);

    if (user) {
      authors = [user.name, ...authors];
      const userName = getMattermostNames([user.name])[0];
      const msg = `PR ${pr.number} by ${pr.user.login} assigned to ${userName} ${pr.html_url}`;

      octokit.rest.pulls.requestReviewers({
        owner: config.github.owner,
        repo: config.github.repo,
        pull_number: pr.number,
        reviewers: [user.name],
      });

      assignedIds.push(pr.number);

      sendMattermostMessage(msg);
    }
  });

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

        sendMattermostMessage(msg);
      }
    });
}

run();
