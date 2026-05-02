const DEFAULT_LINEAR_ENDPOINT = 'https://api.linear.app/graphql';

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  url
  branchName
  createdAt
  updatedAt
  state { name }
  team { key name }
  assignee { name email }
  labels { nodes { name } }
`;

export async function fetchLinearIssues({
  issueIds = [],
  query = null,
  team = null,
  state = null,
  assignee = null,
  limit = 3,
  endpoint = DEFAULT_LINEAR_ENDPOINT,
  apiKey,
  authorization = apiKey,
  fetchFn = fetch
}: any = {}) {
  if (!authorization) {
    throw new Error('Linear delivery requires credentials. Set LINEAR_API_KEY, use --linear-api-key-env, or select --linear-auth oauth with an OAuth token env var.');
  }

  if (issueIds.length > 0) {
    const issues = [];
    for (const issueId of issueIds) {
      const issue = await fetchLinearIssueById({
        id: issueId,
        endpoint,
        authorization,
        fetchFn
      });
      if (issue) {
        issues.push(issue);
      }
    }
    return issues;
  }

  const data = await linearGraphql({
    endpoint,
    authorization,
    fetchFn,
    query: `
      query CouncilLinearIssues($first: Int!, $filter: IssueFilter) {
        issues(first: $first, filter: $filter) {
          nodes {
            ${ISSUE_FIELDS}
          }
        }
      }
    `,
    variables: {
      first: Math.max(1, limit),
      filter: buildIssueFilter({ query, team, state, assignee })
    }
  });

  return normalizeLinearIssues(data?.issues?.nodes || []);
}

export async function fetchLinearIssueById({
  id,
  endpoint = DEFAULT_LINEAR_ENDPOINT,
  apiKey,
  authorization = apiKey,
  fetchFn = fetch
}: any) {
  const data = await linearGraphql({
    endpoint,
    authorization,
    fetchFn,
    query: `
      query CouncilLinearIssue($id: String!) {
        issue(id: $id) {
          ${ISSUE_FIELDS}
        }
      }
    `,
    variables: { id }
  });

  return data?.issue ? normalizeLinearIssue(data.issue) : null;
}

export async function fetchLinearViewer({
  endpoint = DEFAULT_LINEAR_ENDPOINT,
  apiKey,
  authorization = apiKey,
  fetchFn = fetch
}: any = {}) {
  if (!authorization) {
    return null;
  }

  const data = await linearGraphql({
    endpoint,
    authorization,
    fetchFn,
    query: `
      query CouncilLinearViewer {
        viewer {
          id
          name
          email
        }
      }
    `,
    variables: {}
  });

  return data?.viewer || null;
}

async function linearGraphql({ endpoint, apiKey, authorization = apiKey, fetchFn, query, variables }: any) {
  const response = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      authorization,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) {
    throw new Error(`Linear API request failed with HTTP ${response.status}.`);
  }

  const payload = await response.json();
  if (payload.errors?.length > 0) {
    const message = payload.errors
      .map((error) => error?.message)
      .filter(Boolean)
      .join('; ');
    throw new Error(`Linear API request failed: ${message || 'Unknown GraphQL error.'}`);
  }

  return payload.data;
}

function buildIssueFilter({ query, team, state, assignee }) {
  const filter: any = {};

  if (query) {
    filter.or = [
      { identifier: { eq: query } },
      { title: { containsIgnoreCase: query } },
      { description: { containsIgnoreCase: query } }
    ];
  }

  if (team) {
    filter.team = {
      key: {
        eq: team
      }
    };
  }

  if (state) {
    filter.state = {
      name: {
        eq: state
      }
    };
  }

  if (assignee) {
    filter.assignee = {
      or: [
        { name: { containsIgnoreCase: assignee } },
        { email: { containsIgnoreCase: assignee } }
      ]
    };
  }

  return Object.keys(filter).length > 0 ? filter : null;
}

function normalizeLinearIssues(issues) {
  return issues.map(normalizeLinearIssue);
}

function normalizeLinearIssue(issue) {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description || '',
    priority: issue.priority ?? null,
    url: issue.url || null,
    branchName: issue.branchName || null,
    state: issue.state?.name || null,
    team: issue.team?.key || issue.team?.name || null,
    assignee: issue.assignee?.name || issue.assignee?.email || null,
    labels: (issue.labels?.nodes || []).map((label) => label.name).filter(Boolean),
    createdAt: issue.createdAt || null,
    updatedAt: issue.updatedAt || null
  };
}
