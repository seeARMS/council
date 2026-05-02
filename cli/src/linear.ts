import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

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

export async function uploadLinearFile({
  filePath,
  cwd = process.cwd(),
  endpoint = DEFAULT_LINEAR_ENDPOINT,
  apiKey,
  authorization = apiKey,
  fetchFn = fetch,
  makePublic = false,
  metadata = {}
}: any) {
  if (!authorization) {
    throw new Error('Linear file upload requires credentials.');
  }

  const resolvedPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(cwd, filePath);
  const fileStat = await stat(resolvedPath);
  if (!fileStat.isFile()) {
    throw new Error(`Linear media path is not a file: ${filePath}`);
  }

  const filename = path.basename(resolvedPath);
  const contentType = inferContentType(filename);
  const data = await linearGraphql({
    endpoint,
    authorization,
    fetchFn,
    query: `
      mutation CouncilLinearFileUpload(
        $contentType: String!
        $filename: String!
        $size: Int!
        $makePublic: Boolean
        $metaData: JSON
      ) {
        fileUpload(
          contentType: $contentType
          filename: $filename
          size: $size
          makePublic: $makePublic
          metaData: $metaData
        ) {
          success
          uploadFile {
            uploadUrl
            assetUrl
            headers { key value }
          }
        }
      }
    `,
    variables: {
      contentType,
      filename,
      size: fileStat.size,
      makePublic,
      metaData: metadata
    }
  });
  const upload = data?.fileUpload;
  const uploadFile = upload?.uploadFile;
  if (!upload?.success || !uploadFile?.uploadUrl || !uploadFile?.assetUrl) {
    throw new Error('Linear file upload did not return a signed upload URL.');
  }

  const headers = {
    'content-type': contentType,
    'cache-control': 'public, max-age=31536000'
  };
  for (const header of uploadFile.headers || []) {
    if (header?.key && header?.value) {
      headers[header.key] = header.value;
    }
  }

  const fileBuffer = await readFile(resolvedPath);
  const uploadResponse = await fetchFn(uploadFile.uploadUrl, {
    method: 'PUT',
    headers,
    body: fileBuffer
  });

  if (!uploadResponse.ok) {
    throw new Error(`Linear file upload PUT failed with HTTP ${uploadResponse.status}.`);
  }

  return {
    path: resolvedPath,
    filename,
    contentType,
    size: fileStat.size,
    assetUrl: uploadFile.assetUrl,
    uploadUrl: uploadFile.uploadUrl
  };
}

export async function createLinearAttachment({
  issueId,
  title,
  url,
  subtitle = null,
  iconUrl = null,
  metadata = null,
  endpoint = DEFAULT_LINEAR_ENDPOINT,
  apiKey,
  authorization = apiKey,
  fetchFn = fetch
}: any) {
  if (!authorization) {
    throw new Error('Linear attachment creation requires credentials.');
  }

  const input = {
    issueId,
    title,
    url,
    ...(subtitle ? { subtitle } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    ...(metadata ? { metadata } : {})
  };
  const data = await linearGraphql({
    endpoint,
    authorization,
    fetchFn,
    query: `
      mutation CouncilLinearAttachmentCreate($input: AttachmentCreateInput!) {
        attachmentCreate(input: $input) {
          success
          attachment {
            id
            title
            subtitle
            url
          }
        }
      }
    `,
    variables: { input }
  });
  const payload = data?.attachmentCreate;
  if (!payload?.success || !payload?.attachment) {
    throw new Error('Linear attachmentCreate did not return an attachment.');
  }

  return payload.attachment;
}

export async function attachLinearMedia({
  issue,
  media,
  cwd = process.cwd(),
  endpoint = DEFAULT_LINEAR_ENDPOINT,
  apiKey,
  authorization = apiKey,
  fetchFn = fetch,
  titlePrefix = null
}: any) {
  const source = String(media || '').trim();
  if (!source) {
    throw new Error('Linear media source is required.');
  }

  const isRemote = isHttpUrl(source);
  const uploaded = isRemote
    ? null
    : await uploadLinearFile({
        filePath: source,
        cwd,
        endpoint,
        authorization,
        fetchFn,
        metadata: {
          issueId: issue.id,
          source: 'council'
        }
      });
  const url = uploaded?.assetUrl || source;
  const title = titlePrefix
    ? `${titlePrefix}: ${mediaTitle(source)}`
    : mediaTitle(source);
  const attachment = await createLinearAttachment({
    issueId: issue.id,
    title,
    subtitle: isRemote ? 'Attached by Council' : `Uploaded ${uploaded.filename}`,
    url,
    metadata: {
      source: 'council',
      issueIdentifier: issue.identifier,
      mediaSource: isRemote ? source : uploaded.filename
    },
    endpoint,
    authorization,
    fetchFn
  });

  return {
    source,
    url,
    uploaded,
    attachment
  };
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

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

function mediaTitle(value) {
  if (isHttpUrl(value)) {
    try {
      const url = new URL(value);
      return path.basename(url.pathname) || url.hostname;
    } catch {
      return value;
    }
  }

  return path.basename(value);
}

function inferContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const types = {
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.mov': 'video/quicktime',
    '.mp4': 'video/mp4',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain',
    '.webm': 'video/webm',
    '.webp': 'image/webp'
  };

  return types[ext] || 'application/octet-stream';
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
