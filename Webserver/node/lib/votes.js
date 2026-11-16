'use strict';

// Likes and dislikes of games (the launcher's game page), in data/votes.json:
//   { "<placeId>": { "<userId>": 1 | -1 } }
// One vote per account and game; guests (negative IDs) cannot vote.

const fs = require('fs');
const path = require('path');
const core = require('./core');

const DATA = core.rootPath('Webserver', 'node', 'data');
const FILE = path.join(DATA, 'votes.json');

const id = (value) => (/^\d{1,15}$/.test(String(value)) && Number(value) > 0 ? String(Number(value)) : null);

function load() {
  const data = core.readJsonFile(FILE);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

// -> { up, down, mine: 1 | -1 | 0 } for a place, as userId sees it.
function of(placeId, userId, data = load()) {
  const place = id(placeId);
  const votes = (place && data[place]) || {};
  let up = 0;
  let down = 0;
  for (const value of Object.values(votes)) {
    if (value === 1) up++;
    else if (value === -1) down++;
  }
  const user = id(userId);
  const mine = user && (votes[user] === 1 || votes[user] === -1) ? votes[user] : 0;
  return { up, down, mine };
}

// vote: 1 like, -1 dislike, 0 takes the vote back. -> the place's votes.
function cast(placeId, userId, vote) {
  const place = id(placeId);
  const user = id(userId);
  if (!place || !user || ![1, -1, 0].includes(vote)) throw new Error('bad vote');
  const data = load();
  const votes = data[place] && typeof data[place] === 'object' ? data[place] : {};
  if (vote === 0) delete votes[user];
  else votes[user] = vote;
  if (Object.keys(votes).length > 0) data[place] = votes;
  else delete data[place];
  fs.mkdirSync(DATA, { recursive: true });
  if (!core.writeFileAtomic(FILE, `${JSON.stringify(data, null, 2)}\n`)) throw new Error('could not save votes');
  return of(place, user, data);
}

module.exports = { of, cast };
