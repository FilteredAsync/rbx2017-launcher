# rbx2017 website

The public website, in a 2017 style: home, games, game pages, download and
help. It runs on Cloudflare Pages at `www.rbx2017.com`. The bare
`rbx2017.com` stays on the VPS for the game server, and the VPS sends
browsers that open `https://rbx2017.com/` to `www`.

- `public/`: the pages, `css/site.css` and `js/site.js`. Our own code and
  art, no Roblox files or logo.
- `functions/`: Pages Functions. `/api/*` serves the game list, game pages,
  thumbnails, badge and pass icons, and the newest launcher release.
  `/games/<id>` serves the game page. `/download/latest` sends you to the
  newest installer on GitHub.
- `lib/edge.js`: shared by the functions. Answers are trimmed to what the
  pages show (no player names) and cached at Cloudflare's edge. Each edge
  location asks the game server about once per cache period, however many
  people visit. While the game server is down, the site shows the last game
  list it got.

## Try it locally

```
node site/dev-server.mjs
```

Then open http://localhost:8788. It uses the live game server
(`GAME_SERVER=https://... node site/dev-server.mjs` for another one). There
is no edge cache locally.

## Set up Cloudflare Pages (once)

1. In the Cloudflare dashboard, open Workers & Pages, then Create, Pages,
   Connect to Git, and pick the `rbx2017-launcher` repository.
2. Build settings: framework preset None, build command empty, build output
   directory `public`, root directory `site`. Under build watch paths,
   include `site/*` so launcher commits don't redeploy the site.
3. Deploy. Check the `*.pages.dev` address it gives you.
4. In the project's Custom domains, add `www.rbx2017.com`. Cloudflare adds
   the DNS record itself.
5. Once `https://www.rbx2017.com` works, add the redirect on the VPS (as
   root):

   ```
   sed -i 's|^\(rbx2017.com.*{\)$|\1\n\tredir / https://www.rbx2017.com/ 302|' /etc/caddy/Caddyfile
   caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
   ```

   Running `tools/vps/setup-vps.sh` again later needs
   `--site https://www.rbx2017.com` to keep the redirect.

Every push to `main` that changes `site/` redeploys the site.

## Limits

The free plan allows 100,000 function requests a day. A first visit to the
home page uses about 30 (the list, votes and the game thumbnails), and
browsers keep thumbnails for a week. Static pages don't count.
