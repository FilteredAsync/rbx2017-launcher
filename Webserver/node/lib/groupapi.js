'use strict';

// Groups for the launcher and the website (under /api/launcher/, from
// lib/launcherapi.js) and the game engine's GroupService. Rules: lib/groups.js.
//
//   GET  groups                   ?search= -> {groups} (biggest first without a search)
//   GET  groups/mine              (session) your groups with your rank
//   GET  groups/of/<userId>       a player's groups (profiles)
//   GET  groups/<id>              the group's page as you see it
//   GET  groups/<id>/members      ?role=<roleId>&page=
//   GET  groups/<id>/wall         ?page=  (newest first)
//   GET  groups/<id>/requests     (managers) who asked to join
//   POST groups                   (session) {name, description, public}: costs R$ 100
//   POST groups/<id>/join | leave
//   POST groups/<id>/settings     {description, public, name}       (owner)
//   POST groups/<id>/roles        {roles: [{id?, name, rank}]}       (owner)
//   POST groups/<id>/transfer     {userId}                           (owner)
//   POST groups/<id>/emblem       PNG or JPG bytes (image/png|jpeg)  (owner)
//   POST groups/<id>/emblem/remove                                   (owner, server admins)
//   POST groups/<id>/shout        {text}                             (rank 254+)
//   POST groups/<id>/requests/<userId>/accept | decline              (rank 254+)
//   POST groups/<id>/members/<userId>/rank {roleId} | kick           (rank 254+)
//   POST groups/<id>/wall         {text}                             (members)
//   POST groups/<id>/wall/<postId>/delete
//   POST groups/<id>/delete                                          (server admins; owner alone)
// Pictures: group-thumbnail/image?groupId= (any host; 404 without one).
// The engine: groups/<id> (GetGroupInfoAsync), users/<id>/groups
// (GetGroupsAsync), groups/<id>/allies|enemies (none).

const accounts = require('./accounts');
const groups = require('./groups');
const places = require('./places');

const PAGE = 30;
const EMBLEM_LIMIT = 1024 * 1024 + 1024;

module.exports = function groupApi({ send, sendJson, jsonBody, presenceOf, presenceContext }) {
  const nameOf = (userId) => {
    const found = accounts.byUserId(userId);
    return found ? found.name : 'Deleted account';
  };
  const ownerOf = (g) => (g.owner ? { userId: g.owner, name: nameOf(g.owner) } : { userId: 0, name: groups.WEBSITE });
  const emblemUrl = (g) => (g.emblem ? `group-thumbnail/image?groupId=${g.id}&v=${encodeURIComponent(Date.parse(g.emblem.at).toString(36))}` : null);

  function summary(g) {
    return { id: g.id, name: g.name, owner: ownerOf(g), memberCount: g.members.length, emblem: emblemUrl(g), imported: g.imported, public: g.public };
  }

  function gamesOf(g) {
    if (!places.exists()) return [];
    const list = [];
    for (const [placeId, place] of Object.entries(places.load().places)) {
      const creator = places.creatorOf(place);
      if (creator && creator.type === 'Group' && Number(creator.id) === g.id && place.enabled !== false) list.push({ placeId: String(placeId), name: place.name || `Place ${placeId}` });
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  function view(g, viewer) {
    const userId = viewer ? viewer.userId : 0;
    const manage = Boolean(userId && groups.canManage(g, userId));
    const counts = new Map();
    for (const m of g.members) counts.set(m.roleId, (counts.get(m.roleId) || 0) + 1);
    return Object.assign(summary(g), {
      description: g.description,
      created: g.created,
      shout: g.shout ? { text: g.shout.text, by: { userId: g.shout.by, name: nameOf(g.shout.by) }, at: g.shout.at } : null,
      roles: g.roles.map((r) => ({ id: r.id, name: r.name, rank: r.rank, count: counts.get(r.id) || 0 })),
      mine: userId ? groups.membership(g.id, userId) : null,
      requested: Boolean(userId && g.requests.some((r) => r.userId === userId)),
      canManage: manage,
      canOwn: Boolean(userId && groups.canOwn(g, userId)),
      isAdmin: Boolean(userId && groups.isServerAdmin(userId)),
      requestCount: manage ? g.requests.length : 0,
      games: gamesOf(g),
    });
  }

  function members(g, query) {
    const context = presenceContext();
    const roleId = Number(query.role) || 0;
    const page = Math.max(1, Number(query.page) || 1);
    const list = g.members.filter((m) => !roleId || m.roleId === roleId)
      .map((m) => {
        const role = groups.roleOf(g, m.roleId) || groups.lowestRole(g);
        const name = nameOf(m.userId);
        return Object.assign({ userId: m.userId, name, rank: role.rank, role: role.name, roleId: role.id, joined: m.joined }, presenceOf(m.userId, name, context));
      })
      .sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));
    return { members: list.slice((page - 1) * PAGE, page * PAGE), total: list.length, page, pages: Math.max(1, Math.ceil(list.length / PAGE)) };
  }

  function wall(g, query, viewer) {
    const page = Math.max(1, Number(query.page) || 1);
    const userId = viewer ? viewer.userId : 0;
    const manage = Boolean(userId && (groups.canManage(g, userId) || groups.isServerAdmin(userId)));
    const list = g.wall.slice().reverse();
    return {
      posts: list.slice((page - 1) * PAGE, page * PAGE).map((p) => ({
        id: p.id, from: { userId: p.from, name: nameOf(p.from) }, text: p.text, at: p.at, canDelete: Boolean(userId && (manage || p.from === userId)),
      })),
      total: list.length, page, pages: Math.max(1, Math.ceil(list.length / PAGE)),
    };
  }

  const fail = (ctx, result, status = 400) => sendJson(ctx, status, { error: result.error });
  const isJson = (ctx) => /application\/json/i.test(String(ctx.req.headers['content-type'] || ''));

  function handles(action) {
    return /^groups(?:\/|$)/.test(action);
  }

  // viewer: the signed-in account or null.
  async function route(ctx, viewer, action, method) {
    const q = ctx.queryLower;
    const needViewer = () => {
      if (!viewer) sendJson(ctx, 401, { error: 'Sign in first.' });
      return viewer;
    };
    if (method === 'POST' && !/\/emblem$/.test(action) && !isJson(ctx)) return sendJson(ctx, 415, { error: 'Send JSON.' });

    if (action === 'groups') {
      if (method === 'GET') return sendJson(ctx, 200, { groups: groups.search(q.search || '', 60).map(summary), cost: groups.COST });
      if (!needViewer()) return undefined;
      const body = await jsonBody(ctx);
      const result = groups.create(viewer.userId, body);
      return result.error ? fail(ctx, result) : sendJson(ctx, 200, { group: view(result.group, viewer), balance: result.balance });
    }
    if (action === 'groups/mine') {
      if (!needViewer()) return undefined;
      return sendJson(ctx, 200, { groups: groups.groupsOf(viewer.userId).map((entry) => Object.assign(summary(entry.group), { mine: entry.membership })), cost: groups.COST });
    }
    let match = /^groups\/of\/(\d{1,15})$/.exec(action);
    if (match) {
      return sendJson(ctx, 200, { groups: groups.groupsOf(match[1]).map((entry) => Object.assign(summary(entry.group), { role: entry.membership.role, rank: entry.membership.rank })) });
    }
    match = /^groups\/(\d{1,15})(?:\/(.+))?$/.exec(action);
    if (!match) return sendJson(ctx, 404, { error: 'unknown groups request' });
    const g = groups.get(match[1]);
    if (!g) return sendJson(ctx, 404, { error: 'No such group.' });
    const rest = match[2] || '';

    if (method === 'GET') {
      if (!rest) return sendJson(ctx, 200, { group: view(g, viewer) });
      if (rest === 'members') return sendJson(ctx, 200, members(g, q));
      if (rest === 'wall') return sendJson(ctx, 200, wall(g, q, viewer));
      if (rest === 'requests') {
        if (!needViewer()) return undefined;
        if (!groups.canManage(g, viewer.userId)) return sendJson(ctx, 403, { error: 'Only the group\'s admins can see requests.' });
        return sendJson(ctx, 200, { requests: g.requests.map((r) => ({ userId: r.userId, name: nameOf(r.userId), at: r.at })) });
      }
      return sendJson(ctx, 404, { error: 'unknown groups request' });
    }
    if (method !== 'POST') return sendJson(ctx, 405, { error: 'use GET or POST' });
    if (!needViewer()) return undefined;
    const by = viewer.userId;
    if (rest === 'emblem') {
      const type = String(ctx.req.headers['content-type'] || '');
      if (!/^image\/(?:png|jpe?g)/i.test(type)) return sendJson(ctx, 415, { error: 'Use a PNG or JPG picture.' });
      const bytes = await ctx.body(EMBLEM_LIMIT);
      const result = groups.setEmblem(g.id, by, bytes);
      return result.error ? fail(ctx, result) : sendJson(ctx, 200, { group: view(result.group, viewer) });
    }
    const body = await jsonBody(ctx);
    let result;
    let sub;
    if (rest === 'join') result = groups.join(g.id, by);
    else if (rest === 'leave') result = groups.leave(g.id, by);
    else if (rest === 'settings') result = groups.update(g.id, by, body);
    else if (rest === 'roles') result = groups.setRoles(g.id, by, body.roles);
    else if (rest === 'transfer') result = groups.transfer(g.id, by, Number(body.userId));
    else if (rest === 'emblem/remove') result = groups.removeEmblem(g.id, by);
    else if (rest === 'shout') result = groups.setShout(g.id, by, body.text);
    else if (rest === 'wall') result = groups.post(g.id, by, body.text);
    else if (rest === 'delete') {
      result = groups.remove(g.id, by);
      return result.error ? fail(ctx, result) : sendJson(ctx, 200, { ok: true });
    } else if ((sub = /^requests\/(\d{1,15})\/(accept|decline)$/.exec(rest))) result = groups.answerRequest(g.id, by, Number(sub[1]), sub[2] === 'accept');
    else if ((sub = /^members\/(\d{1,15})\/rank$/.exec(rest))) result = groups.setRank(g.id, by, Number(sub[1]), Number(body.roleId));
    else if ((sub = /^members\/(\d{1,15})\/kick$/.exec(rest))) result = groups.kick(g.id, by, Number(sub[1]));
    else if ((sub = /^wall\/(\d{1,12})\/delete$/.exec(rest))) result = groups.deletePost(g.id, by, Number(sub[1]));
    else return sendJson(ctx, 404, { error: 'unknown groups request' });
    if (result.error) return fail(ctx, result);
    const now = groups.get(g.id);
    return sendJson(ctx, 200, { ok: true, joined: Boolean(result.joined), requested: Boolean(result.requested), group: now ? view(now, viewer) : null });
  }

  // --- pictures and the engine --------------------------------------------------------------

  function emblemImage(ctx) {
    const g = groups.get(ctx.queryLower.groupid);
    const file = groups.emblemPath(g);
    let bytes = null;
    try {
      bytes = file ? require('fs').readFileSync(file) : null;
    } catch (error) { /* gone */ }
    if (!bytes) return send(ctx, 404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=60' }, 'No picture');
    send(ctx, 200, { 'Content-Type': /\.jpg$/.test(file) ? 'image/jpeg' : 'image/png', 'Cache-Control': 'public, max-age=300' }, bytes);
  }

  const hostBase = (ctx) => `http://${String(ctx.req.headers['x-forwarded-host'] || ctx.publicHost || ctx.req.headers.host || 'localhost').replace(/[^A-Za-z0-9.:-]/g, '')}/`;

  function engineInfo(ctx, match) {
    const g = groups.get(match[1]);
    if (!g) return sendJson(ctx, 404, { errors: [{ code: 1, message: 'Group is invalid or does not exist.' }] });
    sendJson(ctx, 200, {
      Name: g.name, Id: g.id, Owner: g.owner ? { Name: nameOf(g.owner), Id: g.owner } : null,
      EmblemUrl: g.emblem ? `${hostBase(ctx)}group-thumbnail/image?groupId=${g.id}` : '', Description: g.description,
      Roles: [{ Name: 'Guest', Rank: 0 }, ...g.roles.map((r) => ({ Name: r.name, Rank: r.rank }))],
    });
  }

  function engineGroupsOf(ctx, match) {
    sendJson(ctx, 200, groups.groupsOf(match[1]).map(({ group, membership }) => ({
      Name: group.name, Id: group.id, EmblemUrl: group.emblem ? `${hostBase(ctx)}group-thumbnail/image?groupId=${group.id}` : '', EmblemId: 0,
      Rank: membership.rank, Role: membership.role, IsPrimary: false, IsInClan: false,
    })));
  }

  return {
    handles,
    route,
    summary,
    routes: [
      [/^group-thumbnail\/image\/?$/i, emblemImage],
      [/^groups\/(\d{1,15})\/?$/i, engineInfo],
      [/^groups\/(\d{1,15})\/(?:allies|enemies)\/?$/i, (ctx) => sendJson(ctx, 200, { Groups: [], FinalPage: true })],
      [/^users\/(\d{1,15})\/groups\/?$/i, engineGroupsOf],
    ],
  };
};
