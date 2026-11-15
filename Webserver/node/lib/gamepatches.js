'use strict';

// Fixes for single games whose own scripts break on this server, applied by
// lib/placefile.js to each script's source when a place is converted. A
// patch is recognised by exact lines of the script (not by place ID: a game
// gets other IDs on other servers). Each patch is a list of edits; it is
// applied only when every edit's text is in the script exactly once and none
// of its replacements is there yet, so other scripts are left alone and
// converting again changes nothing.

const count = (text, part) => text.split(part).length - 1;

function edits(name, pairs) {
  return {
    name,
    applies: (source) => pairs.every(([find, replace]) => count(source, find) === 1 && !source.includes(replace)),
    fix: (source) => pairs.reduce((text, [find, replace]) => text.replace(find, () => replace), source),
  };
}

const PATCHES = [
  // The ban list's DataStore key does not exist here, so GetAsync gives nil
  // and checkBan's pairs(banList) errors in PlayerAdded before rememberTools:
  // no player's tools were saved.
  edits('Lumber Tycoon 2 tool saving', [
    ['banList = KickPlayer:GetAsync("PlayerList")', 'banList = KickPlayer:GetAsync("PlayerList") or {}'],
    ['banList = list', 'banList = list or {}'],
    ['in pairs(banList) do', 'in pairs(banList or {}) do'],
  ]),
  // ProcessReceipt gets one receipt table, not (player, productId), and the
  // cash packs (Settings.DevProduct) have .Cash, not .Amount: no purchase paid.
  edits('Jailbreak cash purchases', [
    ['function MarketplaceService.ProcessReceipt(player, productId)',
      'function MarketplaceService.ProcessReceipt(receipt) local player, productId = game:GetService("Players"):GetPlayerByUserId(receipt.PlayerId), receipt.ProductId'],
    ['amount = b.Amount', 'amount = b.Cash'],
    ['if not amount then return Enum.ProductPurchaseDecision.NotProcessedYet end',
      'if not amount or not player then return Enum.ProductPurchaseDecision.NotProcessedYet end'],
  ]),
  // ctr(amount) looks for the pack with ipairs over the credit amounts (hash
  // keys, so the loop never runs) and always returns the 80-credit pack:
  // every buy button prompted that one.
  edits('Phantom Forces credit packs', [
    ['return lastdiff, credits[lastdiff]', 'local pick = credits[tonumber(amount)] and tonumber(amount) or lastdiff; return pick, credits[pick]'],
  ]),
];

// source -> source with the patches that fit applied; their names are added
// to `applied` (a Set).
function apply(source, applied) {
  let text = source;
  for (const patch of PATCHES) {
    if (!patch.applies(text)) continue;
    text = patch.fix(text);
    if (applied) applied.add(patch.name);
  }
  return text;
}

module.exports = { apply, PATCHES };
