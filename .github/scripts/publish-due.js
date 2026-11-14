'use strict';

// Publishes the draft releases that tools/schedule-release.js made once their
// time has come, and turns their "Update coming" notice in announcements.json
// into "Launcher <version> is out". Run every 5 minutes by
// .github/workflows/scheduled-releases.yml. Plain Node 18+, no packages.
//
//   GITHUB_TOKEN=... [GITHUB_REPOSITORY=owner/repo] [DRY_RUN=1] [NOW=<ISO time>] node .github/scripts/publish-due.js
//
// A draft is scheduled when its notes hold a line <!-- publish-at: <UTC ISO time> -->.
// Drafts without one are left alone. DRY_RUN=1 only reads and prints.

const API = 'https://api.github.com';
const ANNOUNCEMENTS = 'announcements.json';
const BRANCH = 'main';
const OUT_FOR_MS = 2 * 86400000;
const MAX_PAGES = 10;
const BOT = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' };
const MARKER = /[ \t]*<!--\s*publish-at:\s*(\S+?)\s*-->[ \t]*/;

// --- pure parts (tested) ----------------------------------------------------------------

// The publish-at time in a release body: milliseconds, NaN when unreadable, null when there is none.
function publishAt(body) {
  const match = MARKER.exec(String(body || ''));
  if (!match) return null;
  return Date.parse(match[1]);
}

const stripMarker = (body) => String(body || '').replace(new RegExp(MARKER.source, 'g'), '').trimEnd();

// "v1.8.0" -> "1.8.0"; server-<build> and others -> null.
function launcherVersion(tag) {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(String(tag || ''));
  return match ? match[1] : null;
}

const compareVersions = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

// Releases from the API (drafts included) + now -> what to do:
//   { type: 'publish', id, tag, version, publishAt, patch }   due drafts; servers first, launchers oldest
//                                                             first so the newest ends up "latest"
//   { type: 'wait', id, tag, publishAt }                      scheduled for later
//   { type: 'warn', id, tag, message }                        marker that cannot be read
function planReleases(releases, now) {
  const publish = [];
  const rest = [];
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || !release.draft) continue;
    const at = publishAt(release.body);
    if (at === null) continue;
    const tag = release.tag_name;
    if (Number.isNaN(at)) {
      rest.push({ type: 'warn', id: release.id, tag, message: 'its publish-at time cannot be read, so it is not published' });
      continue;
    }
    if (at > now) {
      rest.push({ type: 'wait', id: release.id, tag, publishAt: new Date(at).toISOString() });
      continue;
    }
    const version = launcherVersion(tag);
    const prerelease = Boolean(release.prerelease);
    publish.push({
      type: 'publish',
      id: release.id,
      tag,
      version,
      publishAt: new Date(at).toISOString(),
      patch: { draft: false, prerelease, make_latest: version && !prerelease ? 'true' : 'false', body: stripMarker(release.body) },
    });
  }
  publish.sort((a, b) => (a.version ? 1 : 0) - (b.version ? 1 : 0) || (a.version && b.version ? compareVersions(a.version, b.version) : 0));
  return [...publish, ...rest];
}

function releasedNotice(version, now) {
  return {
    id: `released-${version}`,
    title: `Launcher ${version} is out`,
    text: 'It installs by itself the next time you open the launcher.',
    level: 'info',
    postedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + OUT_FOR_MS).toISOString(),
  };
}

// announcements.json's data + the launcher versions that are out -> { data, changed, versions }.
// Each "release-<version>" notice becomes "released-<version>"; when anything
// changed, expired notices are dropped too.
function rewriteAnnouncements(data, outVersions, now) {
  const list = data && Array.isArray(data.announcements) ? data.announcements : [];
  const out = new Set(outVersions);
  const ids = new Set(list.map((item) => item && item.id));
  const versions = [];
  const next = [];
  for (const item of list) {
    const match = item && typeof item.id === 'string' ? /^release-(.+)$/.exec(item.id) : null;
    if (match && out.has(match[1])) {
      versions.push(match[1]);
      if (!ids.has(`released-${match[1]}`)) next.push(releasedNotice(match[1], now));
      continue;
    }
    next.push(item);
  }
  if (!versions.length) return { data, changed: false, versions };
  const kept = next.filter((item) => !(item && item.expiresAt && Date.parse(item.expiresAt) <= now));
  return { data: { ...data, announcements: kept }, changed: true, versions };
}

// --- GitHub -----------------------------------------------------------------------------

function client(token) {
  return async function api(method, url, body) {
    const response = await fetch(`${API}${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'scheduled-releases',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const error = new Error(`${method} ${url} answered HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  };
}

async function listReleases(api, repo) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await api('GET', `/repos/${repo}/releases?per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

async function readAnnouncements(api, repo) {
  try {
    const file = await api('GET', `/repos/${repo}/contents/${ANNOUNCEMENTS}?ref=${BRANCH}`);
    return { sha: file.sha, data: JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')) };
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY || 'FilteredAsync/rbx2017-launcher';
  const dryRun = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');
  const now = process.env.NOW ? Date.parse(process.env.NOW) : Date.now();
  if (!token) throw new Error('GITHUB_TOKEN is not set.');
  if (!Number.isFinite(now)) throw new Error('NOW is not a time.');
  const api = client(token);
  if (dryRun) console.log(`Dry run at ${new Date(now).toISOString()}: nothing is changed.`);

  const releases = await listReleases(api, repo);
  const out = new Set(releases.filter((release) => release && !release.draft).map((release) => launcherVersion(release.tag_name)).filter(Boolean));
  let failed = false;
  for (const action of planReleases(releases, now)) {
    if (action.type === 'wait') {
      console.log(`${action.tag}: scheduled for ${action.publishAt}`);
    } else if (action.type === 'warn') {
      console.log(`::warning::${action.tag}: ${action.message}`);
    } else if (dryRun) {
      console.log(`${action.tag}: due (${action.publishAt}), would publish with ${JSON.stringify({ ...action.patch, body: `${action.patch.body.length} characters` })}`);
      if (action.version) out.add(action.version);
    } else {
      try {
        await api('PATCH', `/repos/${repo}/releases/${action.id}`, action.patch);
        console.log(`${action.tag}: published (due ${action.publishAt})`);
        if (action.version) out.add(action.version);
      } catch (error) {
        failed = true;
        console.log(`::error::${action.tag}: ${error.message}`);
      }
    }
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const file = await readAnnouncements(api, repo);
    const result = file ? rewriteAnnouncements(file.data, out, now) : { changed: false };
    if (!result.changed) break;
    const content = `${JSON.stringify(result.data, null, 2)}\n`;
    const message = `Launcher ${result.versions.join(', ')} is out`;
    if (dryRun) {
      console.log(`Would commit "${message}" to ${ANNOUNCEMENTS}:\n${content}`);
      break;
    }
    try {
      await api('PUT', `/repos/${repo}/contents/${ANNOUNCEMENTS}`, {
        message, content: Buffer.from(content, 'utf8').toString('base64'), sha: file.sha, branch: BRANCH, committer: BOT, author: BOT,
      });
      console.log(`${ANNOUNCEMENTS}: ${message}`);
      break;
    } catch (error) {
      // 409: someone changed the file meanwhile; read it again.
      if (error.status !== 409 || attempt === 3) {
        failed = true;
        console.log(`::error::${ANNOUNCEMENTS}: ${error.message}`);
        break;
      }
    }
  }
  if (failed) process.exitCode = 1;
}

module.exports = { MARKER, publishAt, stripMarker, launcherVersion, planReleases, rewriteAnnouncements, releasedNotice };

if (require.main === module) {
  main().catch((error) => {
    console.log(`::error::${error.message}`);
    process.exit(1);
  });
}
