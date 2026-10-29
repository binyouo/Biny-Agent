---
name: web-search
description: Search the web for information using the built-in WebSearch tool. Use when users ask questions requiring up-to-date information, research, or fact-checking.
allowed-tools:
  - Bash
  - WebSearch
  - WebFetch
  - ToolSearch
  - Skill
---

# Web Search Skill

Search with the **built-in WebSearch tool**, then read relevant sources with WebFetch. Discover tool definitions through ToolSearch when they are not yet exposed. Workspace material should be searched with local file tools.

## WebSearch Tool (Primary)

```
WebSearch(query="your search query", maxResults=5)
```

- Requires Biny Desktop's browser execution endpoint.
- Uses the configured search engine: Google or Xiaohongshu.
- Returns structured links and snippets; a result is not proof that the linked page was read.
- `maxResults` accepts 1–10 and is capped by configuration. Google supports optional `domains` (up to five alternative source domains; any listed domain may supply results) and `recency` (`day`, `week`, `month`, `year`); the other engine does not support these filters.
- Report login walls, verification challenges, and unavailable Desktop execution accurately. Do not promise CAPTCHA bypass.

## Fetching Page Content

After finding URLs from search, use the **WebFetch** tool to get the actual page content:

```
WebFetch(url="https://example.com/article")
```

- Extracts readable text from public HTTP(S) responses; it does not guarantee JavaScript execution or access to a signed-in session.
- Inspect status and final URL before relying on the returned text.
- Use `offset` and `length` to read further passages. Summarize the returned content yourself.

## Browser Skill (Fallback)

If WebSearch or WebFetch fail (e.g., page requires login, CAPTCHA, or multi-step navigation), fall back to the Browser Skill:

```bash
# Open the URL in Biny's sidebar browser (the user watches; keeps its logins)
biny iab goto "https://example.com"

# Read the page content
biny iab info --json
```

Use the browser context requested by the user. For a signed-in Chrome tab, follow `browser`, list the actual browser and tab IDs, then read that tab. Built-in browser sessions and Chrome profiles have separate logins. Do not use a shell command to bypass a refused tool action.

## Tips

- For complex queries, try multiple search approaches
- Summarize findings and cite the actual source URLs next to supported claims.
- Prefer primary sources for technical claims. Read the source page before attributing precise facts, distinguish inference, and compare event dates with publication dates.
- For freshness queries (`today`, `latest`, `今天`, `最新`), use the **current year** from runtime context instead of hardcoding a fixed year
- Use `maxResults` to control the number of search results returned

## Examples

**"Latest AI news":**
```
WebSearch(query="latest AI news <current_year>", maxResults=5)
```

**"Python 3.13 new features":**
```
WebSearch(query="python 3.13 new features", maxResults=5)
```

**Fetch a specific article after search:**
```
WebFetch(url="https://docs.python.org/3.13/whatsnew/3.13.html")
```
