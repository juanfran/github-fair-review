# Github Fair Review

Assigns the oldest unreviewed pull request to the GitHub user who has been inactive in reviews for the longest time and sends a notification via Mattermost.

## Requirements

- Curl
- Node.js 20

## Installation

First, ensure that you have the required dependencies installed in your environment. Then, follow these steps:

```bash
# Copy the sample config file and configure it
cp config.example.json config.json

# Install npm dependencies
npm install
```

## Configuration

The script uses a configuration file `config.json` to specify various parameters. Below is a detailed explanation of each configuration option:

```json
{
  "auth": "",
  "github": {
    "owner": "ownerRepo",
    "repo": "repo"
  },
  "mattermostHook": "",
  "users": [
    {
      "mention": "@susan",
      "github": "susan.github",
      "enabled": true
    },
    {
      "mention": "@john",
      "github": "john.github",
      "enabled": false
    }
  ],
  "tagLists": {
    "frontend": ["susan.github"],
    "backend": ["john.github"]
  },
  "excludeFromReview": ["susan.github"]
}
```

### Configuration Options

- **auth**: This is the GitHub token used for authentication. You need to generate a personal access token from GitHub with the appropriate permissions to access the repository and manage pull requests.

  To create it, go to GitHub **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token** and set:

  - **Resource owner**: the owner of the repository (the organization or user set in `github.owner`), not your personal account. This cannot be changed after the token is created.
  - **Expiration**: as needed, but within the maximum lifetime allowed by the organization, if it sets one.
  - **Repository access**: _Only select repositories_, and select the repository set in `github.repo`.
  - **Repository permissions**:
    - **Contents**: Read-only
    - **Metadata**: Read-only (selected automatically)
    - **Issues**: Read and write (reviewers are assigned through the issues assignees endpoint)
    - **Pull requests**: Read and write

  Also check that:

  - If the resource owner is an organization, an organization owner has approved the token (_Organization settings → Personal access tokens → Pending requests_). Until it is approved, the token only has read access to public data, and assigning reviewers fails with `403 Resource not accessible by personal access token`.
  - Your GitHub account has at least triage access to the repository, because a token can never do more than its owner can.

- **github**: Contains information about the GitHub repository.

  - **owner**: The owner of the repository (usually the username or organization name).
  - **repo**: The name of the repository.

- **mattermostHook**: The webhook URL used to send notifications to Mattermost. You need to configure a webhook in your Mattermost instance and provide the URL here.

- **users**: A list of users who are involved in the pull request review process.

  - **mention**: The Mattermost mention handle for the user.
  - **github**: The GitHub username of the user.
  - **enabled**: A boolean indicating whether the user is enabled for reviews.

- **tagLists**: Optional. Maps a pull request label to a list of GitHub usernames. When a pull request has labels present here, it is only assigned to users in the list of any of those labels. If `tagLists` is set, pull requests without matching labels are skipped, and a warning is shown. If it is not set, any user can be assigned.

- **excludeFromReview**: A list of GitHub usernames that should be excluded from being assigned pull requests for review. This is useful if certain users should not be involved in the review process.

## Running the Script

To run the script, use the following command:

```bash
node index.js
```

To see which pull requests would be assigned and to whom, without assigning them or sending the Mattermost message, use the `--test` parameter:

```bash
node index.js --test
```

Every open pull request without assignee or reviewers gets a reviewer. To decide who has been inactive in reviews for the longest time, the script looks at the latest 100 pull requests by default. Use the `--window` parameter to change it:

```bash
node index.js --window=100
```
