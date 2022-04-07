const { Octokit } = require('@octokit/rest');
const { exec } = require('child_process');
const { formatDistance } = require('date-fns');
const config = require('./config.json');

const fronts = ['rsanchezbalo', 'Xaviju', 'cocotime', 'juanfran'];

function getMattermostNames(names) {
  const mapName = {
    'rsanchezbalo': '@ramiro',
    'Xaviju': '@xaviju',
    'cocotime': '@marina.lopez',
    'juanfran': '@juanfran'
  };

  return names.map((name) => {
    return mapName[name];
  });
}

function getOlder(authorsLog, exclude) {
  let older = {
    position: -1,
    name: '',
  };

  fronts
  .filter((front) => front !== exclude)
  .forEach((front) => {
    const lastPr = [...authorsLog, ...fronts].indexOf(front);

    if (lastPr > older.position) {
      older = {
        position: lastPr,
        name: front
      };
    }
  });

  if (older.name === '') {
    return null;
  }

  return older;
}

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

  return users;
}

async function run() {
  // https://github.com/kaleidos-ventures/taiga
  // https://github.com/settings/tokens (select: repo)
  const octokit = new Octokit(config);

  const allPrs = await octokit.rest.pulls.list({
    owner: 'kaleidos-ventures',
    repo: 'taiga',
    state: 'all',
    per_page: 10,
    page: 0,
    sort: 'created',
    direction: 'desc'
  })

  const validPrs = allPrs.data.filter((pr) => {
    return fronts.includes(pr.user.login);
  });

  const pendingPrs = validPrs.filter((pr) => {
    return pr.state === 'open' && !pr.assignee && !pr.requested_reviewers.length && !pr.title.includes('WIP');
    // return pr.state === 'open' && !pr.assignee && !pr.requested_reviewers.length;
  });

  const inProgressPrs = validPrs.filter((pr) => {
    return pr.state === 'open' && !pr.title.includes('WIP');
  });

  let authors = [];

  validPrs.forEach((pr) => {
    if (pr.assignee?.login) {
      authors.push(pr.assignee?.login);
    }
    if(pr.requested_reviewers?.length) {
      pr.requested_reviewers.forEach((requested_reviewer) => {
        authors.push(requested_reviewer.login);
      })
    }
  });

  authors = authors.filter((author) => {
    return fronts.includes(author);
  });

  pendingPrs.forEach((pr) => {
    console.log(authors);
    const user = getOlder(authors, pr.user.login);

    if (user) {
      authors = [user.name, ...authors];
      const userName = getMattermostNames([user.name])[0];
      const msg = `PR ${pr.number} by ${pr.user.login} assigned to ${userName} ${pr.html_url}`;
      console.log(msg);

      octokit.rest.pulls.requestReviewers({
        owner: 'kaleidos-ventures',
        repo: 'taiga',
        pull_number: pr.number,
        reviewers: [user.name]
      });

      const command = `curl -i -X POST -H 'Content-Type: application/json' -d '{"text": "${msg}"}' https://chat.kaleidos.net/hooks/hqheets8ubyn7g3onr5jak94ya`;
      exec(command);
    }
  });


  inProgressPrs.forEach((pr) => {
    const users = getPrAssign(pr);
    const now = new Date();
    const prDate = new Date(pr.created_at);
    const distance = formatDistance(prDate, now, { addSuffix: true });
    const userNames = getMattermostNames(users);

    const msg = `${pr.html_url} assigned to ${userNames.join(', ')}, open ${distance}`;

    const command = `curl -i -X POST -H 'Content-Type: application/json' -d '{"text": "${msg}"}' https://chat.kaleidos.net/hooks/hqheets8ubyn7g3onr5jak94ya`;
    exec(command);
  });
}

run();
