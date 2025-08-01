const axios = require("axios");
const githubUsernameRegex = require("github-username-regex");

const retryer = require("../common/retryer");
const calculateRank = require("../calculateRank");
const { request, logger, CustomError, parseOwnerAffiliations } = require("../common/utils");

require("dotenv").config();

const fetcher = (variables, token) => {
  return request(
    {
      query: `
      query userInfo($login: String!, $ownerAffiliations: [RepositoryAffiliation]) {
        user(login: $login) {
          name
          login
          contributionsCollection {
            totalCommitContributions
            restrictedContributionsCount
          }
          repositoriesContributedTo(first: 1, contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]) {
            totalCount
          }
          pullRequests(first: 1) {
            totalCount
          }
          openIssues: issues(states: OPEN) {
            totalCount
          }
          closedIssues: issues(states: CLOSED) {
            totalCount
          }
          followers {
            totalCount
          }
          repositories(first: 100, ownerAffiliations: $ownerAffiliations, orderBy: {direction: DESC, field: STARGAZERS}) {
            totalCount
            nodes {
              stargazers {
                totalCount
              }
            }
          }
        }
      }
      `,
      variables,
    },
    {
      Authorization: `bearer ${token}`,
    },
  );
};

const privateAnonymousCommitsFetcher = (variables, token) => {
  const sinceDate = new Date(Date.now() - 12 * 30 * 24 * 60 * 60 * 1000).toISOString();
  return request(
    {
      query: `
      query privateAnonymousInfo($login: String!, $since: GitTimestamp!) {
        user(login: $login) {
          name
          login
          repositories(first: 100, ownerAffiliations: OWNER, isFork: false) {
            totalCount
            nodes {
              name
              defaultBranchRef {
                target {
                  ... on Commit {
                    history(first: 0, since: $since) {
                      totalCount
                    }
                  }
                }
              }
            }
          }
        }
      }
      `,
      variables: {
        ...variables,
        since: sinceDate,
      },
    },
    {
      Authorization: `bearer ${token}`,
    },
  );
};

// https://github.com/anuraghazra/github-readme-stats/issues/92#issuecomment-661026467
// https://github.com/anuraghazra/github-readme-stats/pull/211/
const totalCommitsFetcher = async (username) => {
  if (!githubUsernameRegex.test(username)) {
    logger.log("Invalid username");
    return 0;
  }

  // https://developer.github.com/v3/search/#search-commits
  const fetchTotalCommits = (variables, token) => {
    return axios({
      method: "get",
      url: `https://api.github.com/search/commits?q=author:${variables.login}`,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/vnd.github.cloak-preview",
        Authorization: `token ${token}`,
      },
    });
  };

  try {
    let res = await retryer(fetchTotalCommits, { login: username });
    if (res.data.total_count) {
      return res.data.total_count;
    }
  } catch (err) {
    logger.log(err);
    // just return 0 if there is something wrong so that
    // we don't break the whole app
    return 0;
  }
};

async function fetchStats(
  username,
  ownerAffiliations,
  count_private = false,
  include_all_commits = false,
) {
  if (!username) throw Error("Invalid username");

  const stats = {
    name: "",
    totalPRs: 0,
    totalCommits: 0,
    totalIssues: 0,
    totalStars: 0,
    contributedTo: 0,
    rank: { level: "C", score: 0 },
  };
  ownerAffiliations = parseOwnerAffiliations(ownerAffiliations);

  let res = await retryer(fetcher, { login: username, ownerAffiliations });

  if (res.data.errors) {
    logger.error(res.data.errors);
    throw new CustomError(
      res.data.errors[0].message || "Could not fetch user",
      CustomError.USER_NOT_FOUND,
    );
  }

  let res2 = await retryer(privateAnonymousCommitsFetcher, { login: username });

  if (res2.data.errors) {
    logger.error(res2.data.errors);
    throw new CustomError(
      res2.data.errors[0].message || "Could not fetch user",
      CustomError.USER_NOT_FOUND,
    );
  }

  const user = res.data.data.user;

  stats.name = user.name || user.login;
  stats.totalIssues = user.openIssues.totalCount + user.closedIssues.totalCount;

  // normal commits
  stats.totalCommits = user.contributionsCollection.totalCommitContributions;

  // if include_all_commits then just get that,
  // since totalCommitsFetcher already sends totalCommits no need to +=
  if (include_all_commits) {
    stats.totalCommits = await totalCommitsFetcher(username);
  }

  // if count_private then add private commits to totalCommits so far.
  if (count_private) {
    stats.totalCommits +=
      user.contributionsCollection.restrictedContributionsCount;
  }

  const privateAnonymousRepos = res2.data.data.user.repositories.nodes.filter(repo => repo.name.startsWith("_"))
  const privateAnonymousCommits = privateAnonymousRepos.reduce((prev, curr) => {
    return prev + curr.defaultBranchRef.target.history.totalCount;
  }, 0)
  stats.totalCommits += privateAnonymousCommits

  stats.totalPRs = user.pullRequests.totalCount;
  stats.contributedTo = user.repositoriesContributedTo.totalCount;

  stats.totalStars = user.repositories.nodes.reduce((prev, curr) => {
    return prev + curr.stargazers.totalCount;
  }, 0);

  stats.rank = calculateRank({
    totalCommits: stats.totalCommits,
    totalRepos: user.repositories.totalCount,
    followers: user.followers.totalCount,
    contributions: stats.contributedTo,
    stargazers: stats.totalStars,
    prs: stats.totalPRs,
    issues: stats.totalIssues,
  });

  // console.log(stats)

  return stats;
}

module.exports = fetchStats;
