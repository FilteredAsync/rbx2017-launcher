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
- `lib/account.js`: logging in and signing up (the launcher's accounts, on
  the game server), and the signed-in pages: `/home` with your friends and
  R$, and R$ with your name in the header. The session is an HttpOnly
  cookie. These answers are each visitor's own, so they aren't cached.

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

The live site deploys from the `site-live` branch (Settings, Builds, Branch
control: production branch `site-live`, preview deployments None), so
pushes to `main` don't change it. It goes out with a release:

```
git push origin main:site-live
```

## Set up signing in (once)

1. The website key: on the game server's /manage page, open Server, then
   Website key, Show, Copy.
2. In the Cloudflare Pages project, open Settings, Variables and Secrets,
   and add `SITE_KEY` (type Secret) with that key. Without it, logins still
   work, but the game server's wrong-password limit counts everyone on the
   website as one visitor.
3. The human check on Sign Up (recommended): in the Cloudflare dashboard,
   open Turnstile, Add widget, hostname `www.rbx2017.com`, mode Managed.
   Add its Site Key as `TURNSTILE_SITE_KEY` (type Text) and its Secret Key
   as `TURNSTILE_SECRET` (type Secret). Without both, sign-ups skip it.
4. Variables apply to new deployments: open Deployments and retry the
   latest one.

Locally: `SITE_KEY=... GAME_SERVER=http://127.0.0.1:<port> node
site/dev-server.mjs`, with `DEV_CLIENT_IP=<a public IP>` to stand in for
the visitor address Cloudflare adds.

## Limits

The free plan allows 100,000 function requests a day. A first visit to the
home page uses about 30 (the list, votes and the game thumbnails), and
browsers keep thumbnails for a week. Static pages don't count. Every page
also asks `/api/me` (kept for 30 seconds in the tab); for signed-in
visitors that asks the game server twice, and `/home` adds their friends.
