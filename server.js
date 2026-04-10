import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
app.use(express.json());

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REDDIT_BASE = 'https://www.reddit.com';

// ─── Fetch Helpers ────────────────────────────────────────────────────────────
async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }
  });
  if (res.status === 429) throw new Error('Reddit rate limit hit. Please wait a moment and try again.');
  if (res.status === 403) throw new Error('Access denied — subreddit may be private or quarantined.');
  if (!res.ok) throw new Error(`Reddit error: ${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchRSS(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/rss+xml, application/xml, text/xml' }
  });
  if (res.status === 429) throw new Error('Reddit rate limit hit. Please wait a moment.');
  if (res.status === 403) throw new Error('Access denied — subreddit may be private or quarantined.');
  if (!res.ok) throw new Error(`Reddit error: ${res.status} ${res.statusText}`);
  return res.text();
}

// ─── RSS Parser (no external deps) ───────────────────────────────────────────
function parseRSS(xml) {
  const items = [];
  const itemMatches = xml.match(/<entry>([\s\S]*?)<\/entry>/g) || 
                      xml.match(/<item>([\s\S]*?)<\/item>/g) || [];

  for (const item of itemMatches) {
    const get = (tag) => {
      const m = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
    };
    const getAttr = (tag, attr) => {
      const m = item.match(new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i'));
      return m ? m[1] : '';
    };

    const link = getAttr('link', 'href') || get('link') || '';
    const title = get('title') || 'No title';
    const author = get('author') ? get('author').replace(/<[^>]+>/g, '').replace('/u/', '').trim() : 'unknown';
    const content = get('content') || get('description') || '';
    const score = content.match(/(\d+)\s*point/i)?.[1] || 'N/A';
    const comments = content.match(/(\d+)\s*comment/i)?.[1] || '0';
    const updated = get('updated') || get('pubDate') || '';
    const subredditMatch = link.match(/reddit\.com\/r\/([^/]+)/);
    const subreddit = subredditMatch ? `r/${subredditMatch[1]}` : '';

    if (title && link) {
      items.push({ title, permalink: link, subreddit, author, score, num_comments: parseInt(comments), created: updated });
    }
  }
  return items;
}

function parseSubredditAbout(xml) {
  const get = (tag) => {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
  };
  return { title: get('title'), description: get('subtitle') || get('description') };
}

// ─── Formatters ───────────────────────────────────────────────────────────────
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
    body_preview: d.selftext ? d.selftext.substring(0, 600) + (d.selftext.length > 600 ? '...' : '') : null,
    flair: d.link_flair_text || null,
    created: new Date(d.created_utc * 1000).toISOString()
  };
}

function formatComment(comment, depth = 0) {
  if (!comment?.data || comment.kind === 'more') return null;
  const d = comment.data;
  if (!d.body || d.body === '[deleted]' || d.body === '[removed]') return null;
  const result = {
    author: d.author,
    body: d.body.substring(0, 1000) + (d.body.length > 1000 ? '...' : ''),
    score: d.score,
    depth,
    replies: []
  };
  if (depth < 2 && d.replies?.data?.children) {
    result.replies = d.replies.data.children
      .map(c => formatComment(c, depth + 1)).filter(Boolean).slice(0, 3);
  }
  return result;
}

// ─── Tool Handlers ────────────────────────────────────────────────────────────
async function redditSearch({ query, subreddit, sort = 'relevance', time = 'all', limit = 10 }) {
  const n = Math.min(Math.max(1, Number(limit) || 10), 25);

  // Try JSON first, fall back to RSS
  try {
    const path = subreddit
      ? `/r/${subreddit}/search.json?q=${encodeURIComponent(query)}&sort=${sort}&t=${time}&limit=${n}&restrict_sr=1`
      : `/search.json?q=${encodeURIComponent(query)}&sort=${sort}&t=${time}&limit=${n}`;
    const data = await fetchJSON(`${REDDIT_BASE}${path}`);
    return {
      query, scope: subreddit ? `r/${subreddit}` : 'all of Reddit',
      source: 'reddit-json',
      result_count: data.data.children.length,
      posts: data.data.children.map(formatPost)
    };
  } catch (e) {
    // Fall back to RSS
    const rssUrl = subreddit
      ? `${REDDIT_BASE}/r/${subreddit}/search.rss?q=${encodeURIComponent(query)}&sort=${sort}&t=${time}&limit=${n}&restrict_sr=1`
      : `${REDDIT_BASE}/search.rss?q=${encodeURIComponent(query)}&sort=${sort}&t=${time}&limit=${n}`;
    const xml = await fetchRSS(rssUrl);
    const posts = parseRSS(xml).slice(0, n);
    return {
      query, scope: subreddit ? `r/${subreddit}` : 'all of Reddit',
      source: 'reddit-rss',
      result_count: posts.length,
      posts
    };
  }
}

async function redditGetPosts({ subreddit, sort = 'hot', time = 'week', limit = 10 }) {
  const n = Math.min(Math.max(1, Number(limit) || 10), 25);

  try {
    const data = await fetchJSON(`${REDDIT_BASE}/r/${subreddit}/${sort}.json?t=${time}&limit=${n}`);
    return { subreddit: `r/${subreddit}`, sort, source: 'reddit-json', posts: data.data.children.map(formatPost) };
  } catch (e) {
    const xml = await fetchRSS(`${REDDIT_BASE}/r/${subreddit}/${sort}.rss?t=${time}&limit=${n}`);
    const posts = parseRSS(xml).slice(0, n);
    return { subreddit: `r/${subreddit}`, sort, source: 'reddit-rss', posts };
  }
}

async function redditGetComments({ permalink, comment_limit = 10 }) {
  const n = Math.min(Math.max(1, Number(comment_limit) || 10), 20);
  let path = permalink.includes('reddit.com') ? permalink.split('reddit.com')[1] : permalink;
  path = path.replace(/\/$/, '').replace(/\.json$/, '');

  const data = await fetchJSON(`${REDDIT_BASE}${path}.json?limit=${n}&depth=3`);
  const post = formatPost(data[0].data.children[0]);
  const comments = data[1].data.children
    .map(c => formatComment(c, 0)).filter(Boolean).slice(0, n);
  return { post, comment_count: comments.length, comments };
}

async function redditSubredditInfo({ subreddit }) {
  try {
    const data = await fetchJSON(`${REDDIT_BASE}/r/${subreddit}/about.json`);
    const d = data.data;
    return {
      name: `r/${d.display_name}`, title: d.title,
      description: d.public_description,
      subscribers: d.subscribers?.toLocaleString(),
      active_users: d.accounts_active?.toLocaleString() || 'N/A',
      nsfw: d.over18,
      created: new Date(d.created_utc * 1000).toISOString(),
      url: `https://www.reddit.com/r/${subreddit}/`
    };
  } catch (e) {
    const xml = await fetchRSS(`${REDDIT_BASE}/r/${subreddit}/.rss`);
    const info = parseSubredditAbout(xml);
    return {
      name: `r/${subreddit}`, title: info.title,
      description: info.description,
      url: `https://www.reddit.com/r/${subreddit}/`,
      note: 'Limited info — using RSS fallback'
    };
  }
}

// ─── Tools Definition ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'reddit_search',
    description: 'Search Reddit for posts matching a query. Searches all of Reddit or a specific subreddit.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        subreddit: { type: 'string', description: 'Optional: limit to this subreddit (without r/)' },
        sort: { type: 'string', enum: ['relevance', 'hot', 'top', 'new', 'comments'], description: 'Sort order. Default: relevance' },
        time: { type: 'string', enum: ['all', 'year', 'month', 'week', 'day', 'hour'], description: 'Time filter. Default: all' },
        limit: { type: 'number', description: 'Results (1-25). Default: 10' }
      },
      required: ['query']
    }
  },
  {
    name: 'reddit_get_posts',
    description: 'Get hot, new, top, or rising posts from any subreddit.',
    inputSchema: {
      type: 'object',
      properties: {
        subreddit: { type: 'string', description: 'Subreddit name without r/' },
        sort: { type: 'string', enum: ['hot', 'new', 'top', 'rising'], description: 'Default: hot' },
        time: { type: 'string', enum: ['all', 'year', 'month', 'week', 'day', 'hour'], description: 'Default: week' },
        limit: { type: 'number', description: 'Number of posts (1-25). Default: 10' }
      },
      required: ['subreddit']
    }
  },
  {
    name: 'reddit_get_comments',
    description: 'Fetch a Reddit post and its top comments using the post permalink.',
    inputSchema: {
      type: 'object',
      properties: {
        permalink: { type: 'string', description: 'Reddit post permalink or full URL' },
        comment_limit: { type: 'number', description: 'Number of comments (1-20). Default: 10' }
      },
      required: ['permalink']
    }
  },
  {
    name: 'reddit_subreddit_info',
    description: 'Get info about a subreddit: title, description, subscriber count.',
    inputSchema: {
      type: 'object',
      properties: { subreddit: { type: 'string', description: 'Subreddit name without r/' } },
      required: ['subreddit']
    }
  }
];

// ─── MCP Server ───────────────────────────────────────────────────────────────
function createMCPServer() {
  const server = new Server({ name: 'reddit-mcp', version: '2.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      let result;
      switch (name) {
        case 'reddit_search':         result = await redditSearch(args); break;
        case 'reddit_get_posts':      result = await redditGetPosts(args); break;
        case 'reddit_get_comments':   result = await redditGetComments(args); break;
        case 'reddit_subreddit_info': result = await redditSubredditInfo(args); break;
        default: throw new Error(`Unknown tool: ${name}`);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  });

  return server;
}

// ─── SSE Transport ────────────────────────────────────────────────────────────
const transports = {};

app.get('/mcp', async (req, res) => {
  const transport = new SSEServerTransport('/mcp', res);
  transports[transport.sessionId] = transport;
  res.on('close', () => delete transports[transport.sessionId]);
  await createMCPServer().connect(transport);
});

app.post('/mcp', async (req, res) => {
  const transport = transports[req.query.sessionId];
  if (!transport) return res.status(404).json({ error: 'Session not found.' });
  await transport.handlePostMessage(req, res, req.body);
});

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'reddit-mcp', version: '2.0.0', tools: TOOLS.map(t => t.name) }));
app.get('/', (_, res) => res.json({ message: 'Reddit MCP Server is running. Connect via /mcp' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Reddit MCP v2 running on port ${PORT}`));

export default app;
