import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
app.use(express.json());

const REDDIT_BASE = 'https://www.reddit.com';
const OLD_REDDIT  = 'https://old.reddit.com';
const API_REDDIT  = 'https://api.reddit.com';

const AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:123.0) Gecko/20100101 Firefox/123.0'
];

function randomAgent() {
  return AGENTS[Math.floor(Math.random() * AGENTS.length)];
}

async function tryFetch(url, opts = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': randomAgent(),
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      ...opts.headers
    },
    ...opts
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchRSS(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': randomAgent(), 'Accept': 'text/xml,application/rss+xml' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Try multiple base URLs for JSON endpoints
async function fetchJSONWithFallback(path) {
  const urls = [
    `${REDDIT_BASE}${path}`,
    `${OLD_REDDIT}${path}`,
    `${API_REDDIT}${path}`
  ];
  let lastErr;
  for (const url of urls) {
    try {
      return await tryFetch(url);
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 300));
    }
  }
  throw lastErr;
}

// ─── RSS Parser ───────────────────────────────────────────────────────────────
function parseRSS(xml) {
  const items = [];
  const blocks = xml.match(/<entry>([\s\S]*?)<\/entry>/g) ||
                 xml.match(/<item>([\s\S]*?)<\/item>/g) || [];

  for (const block of blocks) {
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim() : '';
    };
    const getAttr = (tag, attr) => {
      const m = block.match(new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i'));
      return m ? m[1] : '';
    };
    const link = getAttr('link', 'href') || get('link') || '';
    const title = get('title') || '';
    const author = get('name') || get('author') || 'unknown';
    const content = get('content') || get('description') || '';
    const score = content.match(/(\d+)\s*point/i)?.[1] || 'N/A';
    const numComments = parseInt(content.match(/(\d+)\s*comment/i)?.[1] || '0');
    const updated = get('updated') || get('pubDate') || '';
    const subMatch = link.match(/reddit\.com\/r\/([^/]+)/);
    const subreddit = subMatch ? `r/${subMatch[1]}` : '';
    if (title && link) {
      items.push({ title, permalink: link, subreddit, author, score, num_comments: numComments, created: updated, body_preview: null });
    }
  }
  return items;
}

// Parse comment RSS (limited but works)
function parseCommentRSS(xml) {
  const items = [];
  const blocks = xml.match(/<entry>([\s\S]*?)<\/entry>/g) ||
                 xml.match(/<item>([\s\S]*?)<\/item>/g) || [];

  for (const block of blocks) {
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim() : '';
    };
    const title = get('title') || '';
    const content = get('content') || get('description') || '';
    const author = get('name') || get('author') || 'unknown';
    const updated = get('updated') || get('pubDate') || '';
    if (content) {
      items.push({ author, body: content.substring(0, 800), created: updated, score: 'N/A', depth: 0, replies: [] });
    }
  }
  return items;
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
  const jsonPath = subreddit
    ? `/r/${subreddit}/search.json?q=${encodeURIComponent(query)}&sort=${sort}&t=${time}&limit=${n}&restrict_sr=1`
    : `/search.json?q=${encodeURIComponent(query)}&sort=${sort}&t=${time}&limit=${n}`;

  try {
    const data = await fetchJSONWithFallback(jsonPath);
    return { query, scope: subreddit || 'all', source: 'json', result_count: data.data.children.length, posts: data.data.children.map(formatPost) };
  } catch {
    const rssUrl = subreddit
      ? `${REDDIT_BASE}/r/${subreddit}/search.rss?q=${encodeURIComponent(query)}&sort=${sort}&t=${time}&limit=${n}&restrict_sr=1`
      : `${REDDIT_BASE}/search.rss?q=${encodeURIComponent(query)}&sort=${sort}&t=${time}&limit=${n}`;
    const xml = await fetchRSS(rssUrl);
    const posts = parseRSS(xml).slice(0, n);
    return { query, scope: subreddit || 'all', source: 'rss', result_count: posts.length, posts };
  }
}

async function redditGetPosts({ subreddit, sort = 'hot', time = 'week', limit = 10 }) {
  const n = Math.min(Math.max(1, Number(limit) || 10), 25);
  try {
    const data = await fetchJSONWithFallback(`/r/${subreddit}/${sort}.json?t=${time}&limit=${n}`);
    return { subreddit: `r/${subreddit}`, sort, source: 'json', posts: data.data.children.map(formatPost) };
  } catch {
    const xml = await fetchRSS(`${REDDIT_BASE}/r/${subreddit}/${sort}.rss?t=${time}&limit=${n}`);
    const posts = parseRSS(xml).slice(0, n);
    return { subreddit: `r/${subreddit}`, sort, source: 'rss', posts };
  }
}

async function redditGetComments({ permalink, comment_limit = 10 }) {
  const n = Math.min(Math.max(1, Number(comment_limit) || 10), 20);

  // Normalize path
  let path = permalink.includes('reddit.com') ? permalink.split('reddit.com')[1] : permalink;
  path = path.replace(/\/$/, '').replace(/\.json$/, '');

  // Attempt 1: JSON from multiple base URLs
  try {
    const data = await fetchJSONWithFallback(`${path}.json?limit=${n}&depth=3`);
    const post = formatPost(data[0].data.children[0]);
    const comments = data[1].data.children.map(c => formatComment(c, 0)).filter(Boolean).slice(0, n);
    return { source: 'json', post, comment_count: comments.length, comments };
  } catch (e1) {
    // Attempt 2: Comment RSS feed
    try {
      const rssUrl = `${REDDIT_BASE}${path}.rss?limit=${n}`;
      const xml = await fetchRSS(rssUrl);
      const comments = parseCommentRSS(xml);

      // Also try to get post info from JSON listing
      let postInfo = { title: 'See permalink for details', permalink: `${REDDIT_BASE}${path}` };
      try {
        const postData = await fetchJSONWithFallback(`${path}.json?limit=1&depth=0`);
        postInfo = formatPost(postData[0].data.children[0]);
      } catch {}

      return {
        source: 'rss-fallback',
        note: 'Full JSON blocked — returning RSS comments (limited data)',
        post: postInfo,
        comment_count: comments.length,
        comments
      };
    } catch (e2) {
      // Attempt 3: Return post link so user can fetch manually
      return {
        source: 'blocked',
        note: 'Reddit is blocking comment access from this server. Use the permalink below with web_fetch or visit directly.',
        permalink: `${REDDIT_BASE}${path}`,
        suggestion: `Try: fetch the page at ${REDDIT_BASE}${path}`
      };
    }
  }
}

async function redditSubredditInfo({ subreddit }) {
  try {
    const data = await fetchJSONWithFallback(`/r/${subreddit}/about.json`);
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
  } catch {
    const xml = await fetchRSS(`${REDDIT_BASE}/r/${subreddit}/.rss`);
    const get = (tag) => {
      const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim() : '';
    };
    return { name: `r/${subreddit}`, title: get('title'), description: get('subtitle') || '', url: `${REDDIT_BASE}/r/${subreddit}/`, source: 'rss' };
  }
}

// ─── Tools ────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'reddit_search',
    description: 'Search Reddit for posts. Can scope to a specific subreddit.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string' },
      subreddit: { type: 'string', description: 'Optional subreddit name without r/' },
      sort: { type: 'string', enum: ['relevance','hot','top','new','comments'] },
      time: { type: 'string', enum: ['all','year','month','week','day','hour'] },
      limit: { type: 'number' }
    }, required: ['query'] }
  },
  {
    name: 'reddit_get_posts',
    description: 'Get hot/new/top/rising posts from a subreddit.',
    inputSchema: { type: 'object', properties: {
      subreddit: { type: 'string' },
      sort: { type: 'string', enum: ['hot','new','top','rising'] },
      time: { type: 'string', enum: ['all','year','month','week','day','hour'] },
      limit: { type: 'number' }
    }, required: ['subreddit'] }
  },
  {
    name: 'reddit_get_comments',
    description: 'Fetch a Reddit post and comments by permalink. Has multiple fallback methods.',
    inputSchema: { type: 'object', properties: {
      permalink: { type: 'string', description: 'Full Reddit URL or path' },
      comment_limit: { type: 'number' }
    }, required: ['permalink'] }
  },
  {
    name: 'reddit_subreddit_info',
    description: 'Get subreddit metadata: title, description, subscriber count.',
    inputSchema: { type: 'object', properties: {
      subreddit: { type: 'string' }
    }, required: ['subreddit'] }
  }
];

// ─── MCP Server ───────────────────────────────────────────────────────────────
function createMCPServer() {
  const server = new Server({ name: 'reddit-mcp', version: '3.0.0' }, { capabilities: { tools: {} } });
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
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'reddit-mcp', version: '3.0.0', tools: TOOLS.map(t => t.name) }));
app.get('/', (_, res) => res.json({ message: 'Reddit MCP Server v3 running. Connect via /mcp' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Reddit MCP v3 running on port ${PORT}`));
export default app;
