import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
app.use(express.json());

// ─── Reddit API Config ───────────────────────────────────────────────────────
const REDDIT_BASE = 'https://www.reddit.com';
const USER_AGENT = 'ClaudeRedditMCP/1.0.0 (MCP connector for Claude AI assistant)';

async function fetchReddit(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json'
    }
  });

  if (response.status === 429) {
    throw new Error('Reddit rate limit hit. Please wait a moment and try again.');
  }
  if (response.status === 403) {
    throw new Error('Reddit returned 403 — subreddit may be private or quarantined.');
  }
  if (!response.ok) {
    throw new Error(`Reddit API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

// ─── Data Formatters ─────────────────────────────────────────────────────────
function formatPost(post) {
  const d = post.data;
  return {
    id: d.id,
    title: d.title,
    subreddit: `r/${d.subreddit}`,
    author: d.author,
    score: d.score,
    upvote_ratio: d.upvote_ratio ? `${Math.round(d.upvote_ratio * 100)}%` : 'N/A',
    num_comments: d.num_comments,
    permalink: `https://www.reddit.com${d.permalink}`,
    external_url: d.is_self ? null : d.url,
    body_preview: d.selftext
      ? d.selftext.substring(0, 800) + (d.selftext.length > 800 ? '...' : '')
      : null,
    flair: d.link_flair_text || null,
    created: new Date(d.created_utc * 1000).toISOString(),
    is_text_post: d.is_self
  };
}

function formatComment(comment, depth = 0) {
  if (!comment || !comment.data || comment.kind === 'more') return null;
  const d = comment.data;
  if (!d.body || d.body === '[deleted]' || d.body === '[removed]') return null;

  const result = {
    id: d.id,
    author: d.author,
    body: d.body.substring(0, 1200) + (d.body.length > 1200 ? '...' : ''),
    score: d.score,
    depth,
    created: new Date(d.created_utc * 1000).toISOString(),
    replies: []
  };

  if (depth < 2 && d.replies?.data?.children) {
    result.replies = d.replies.data.children
      .map(c => formatComment(c, depth + 1))
      .filter(Boolean)
      .slice(0, 3);
  }

  return result;
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'reddit_search',
    description: 'Search Reddit for posts matching a query. Can search all of Reddit or within a specific subreddit. Returns post titles, scores, comment counts, and permalinks.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (e.g. "best practices for ORR compliance")'
        },
        subreddit: {
          type: 'string',
          description: 'Optional: limit search to this subreddit name (without r/). Example: "legaladvice"'
        },
        sort: {
          type: 'string',
          enum: ['relevance', 'hot', 'top', 'new', 'comments'],
          description: 'Sort order. Default: relevance'
        },
        time: {
          type: 'string',
          enum: ['all', 'year', 'month', 'week', 'day', 'hour'],
          description: 'Time filter. Default: all'
        },
        limit: {
          type: 'number',
          description: 'Number of results to return (1–25). Default: 10'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'reddit_get_posts',
    description: 'Get current hot, new, top, or rising posts from a subreddit.',
    inputSchema: {
      type: 'object',
      properties: {
        subreddit: {
          type: 'string',
          description: 'Subreddit name without r/ (e.g. "childcare", "socialwork")'
        },
        sort: {
          type: 'string',
          enum: ['hot', 'new', 'top', 'rising'],
          description: 'Sort order. Default: hot'
        },
        time: {
          type: 'string',
          enum: ['all', 'year', 'month', 'week', 'day', 'hour'],
          description: 'Time filter (applies to top). Default: week'
        },
        limit: {
          type: 'number',
          description: 'Number of posts (1–25). Default: 10'
        }
      },
      required: ['subreddit']
    }
  },
  {
    name: 'reddit_get_comments',
    description: 'Fetch a Reddit post and its top comments. Use this after reddit_search to read the full content and discussion of a specific post.',
    inputSchema: {
      type: 'object',
      properties: {
        permalink: {
          type: 'string',
          description: 'Reddit post permalink or full URL. Example: "/r/legaladvice/comments/abc123/title/" or "https://www.reddit.com/r/..."'
        },
        comment_limit: {
          type: 'number',
          description: 'Number of top-level comments to fetch (1–20). Default: 10'
        }
      },
      required: ['permalink']
    }
  },
  {
    name: 'reddit_subreddit_info',
    description: 'Get metadata about a subreddit: description, subscriber count, activity level, creation date.',
    inputSchema: {
      type: 'object',
      properties: {
        subreddit: {
          type: 'string',
          description: 'Subreddit name without r/'
        }
      },
      required: ['subreddit']
    }
  }
];

// ─── Tool Handlers ────────────────────────────────────────────────────────────
async function redditSearch({ query, subreddit, sort = 'relevance', time = 'all', limit = 10 }) {
  const n = Math.min(Math.max(1, Number(limit) || 10), 25);
  let url;

  if (subreddit) {
    url = `${REDDIT_BASE}/r/${subreddit}/search.json?q=${encodeURIComponent(query)}&sort=${sort}&t=${time}&limit=${n}&restrict_sr=1`;
  } else {
    url = `${REDDIT_BASE}/search.json?q=${encodeURIComponent(query)}&sort=${sort}&t=${time}&limit=${n}`;
  }

  const data = await fetchReddit(url);
  const posts = data.data.children.map(formatPost);

  return {
    query,
    scope: subreddit ? `r/${subreddit}` : 'all of Reddit',
    result_count: posts.length,
    posts
  };
}

async function redditGetPosts({ subreddit, sort = 'hot', time = 'week', limit = 10 }) {
  const n = Math.min(Math.max(1, Number(limit) || 10), 25);
  const url = `${REDDIT_BASE}/r/${subreddit}/${sort}.json?t=${time}&limit=${n}`;
  const data = await fetchReddit(url);

  return {
    subreddit: `r/${subreddit}`,
    sort,
    posts: data.data.children.map(formatPost)
  };
}

async function redditGetComments({ permalink, comment_limit = 10 }) {
  const n = Math.min(Math.max(1, Number(comment_limit) || 10), 20);

  // Normalize permalink to a path
  let path = permalink;
  if (path.includes('reddit.com')) {
    path = path.split('reddit.com')[1];
  }
  path = path.replace(/\/$/, '');
  if (!path.endsWith('.json')) path += '.json';

  const url = `${REDDIT_BASE}${path}?limit=${n}&depth=3`;
  const data = await fetchReddit(url);

  const post = formatPost(data[0].data.children[0]);
  const comments = data[1].data.children
    .map(c => formatComment(c, 0))
    .filter(Boolean)
    .slice(0, n);

  return {
    post,
    comment_count: comments.length,
    comments
  };
}

async function redditSubredditInfo({ subreddit }) {
  const url = `${REDDIT_BASE}/r/${subreddit}/about.json`;
  const data = await fetchReddit(url);
  const d = data.data;

  return {
    name: `r/${d.display_name}`,
    title: d.title,
    description: d.public_description,
    subscribers: d.subscribers?.toLocaleString(),
    active_users: d.accounts_active?.toLocaleString() || 'N/A',
    nsfw: d.over18,
    created: new Date(d.created_utc * 1000).toISOString(),
    url: `https://www.reddit.com${d.url}`
  };
}

// ─── MCP Server Factory ───────────────────────────────────────────────────────
function createMCPServer() {
  const server = new Server(
    { name: 'reddit-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result;
      switch (name) {
        case 'reddit_search':       result = await redditSearch(args); break;
        case 'reddit_get_posts':    result = await redditGetPosts(args); break;
        case 'reddit_get_comments': result = await redditGetComments(args); break;
        case 'reddit_subreddit_info': result = await redditSubredditInfo(args); break;
        default: throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true
      };
    }
  });

  return server;
}

// ─── SSE Transport Layer ──────────────────────────────────────────────────────
const transports = {};

app.get('/mcp', async (req, res) => {
  const transport = new SSEServerTransport('/mcp', res);
  transports[transport.sessionId] = transport;

  res.on('close', () => {
    delete transports[transport.sessionId];
  });

  const server = createMCPServer();
  await server.connect(transport);
});

app.post('/mcp', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];

  if (!transport) {
    return res.status(404).json({ error: 'Session not found. Reconnect and retry.' });
  }

  await transport.handlePostMessage(req, res, req.body);
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (_, res) => {
  res.json({
    status: 'ok',
    service: 'reddit-mcp',
    version: '1.0.0',
    tools: TOOLS.map(t => t.name)
  });
});

app.get('/', (_, res) => {
  res.json({ message: 'Reddit MCP Server is running. Connect via /mcp' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Reddit MCP server running on port ${PORT}`);
  console.log(`   MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
});

export default app;
