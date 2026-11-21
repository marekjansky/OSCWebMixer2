"use strict";

/**
 * Identity tracking for desk slots (auxes and input channels).
 *
 * state.json remembers the last CONFIRMED desk name of every aux and channel (`name`). When the
 * desk reports a different name for a slot, the slot has probably been given to someone else
 * (renamed, or the session was restructured), so:
 *  - the slot is flagged as changed until the engineer confirms it in the admin page,
 *  - device locks on that aux are suspended (locks keep their own `auxName` so that loading a
 *    preset never changes lock state),
 *  - a colour that was the automatic colour of the old name follows the new name.
 *
 * Names are compared trimmed, case-insensitively and with whitespace collapsed, so a change of
 * spelling ("bass" -> "Bass") is not treated as a different musician.
 *
 * This module is pure so it can be unit tested.
 */

const { colourForName, normaliseName, sameColour } = require("./colour.js");

/**
 * @typedef {"unknown"|"first"|"same"|"changed"} NameStatus
 *  unknown - the desk hasn't reported a name for the slot
 *  first   - nothing stored yet: just remember the desk name, no flag
 *  same    - the desk name matches the stored name
 *  changed - the desk name differs from the stored name: needs confirmation
 */

/**
 * @param {unknown} storedName - the last confirmed name
 * @param {unknown} deskName - the name the desk reports now (undefined when not known)
 * @returns {NameStatus}
 */
function nameStatus(storedName, deskName)
{
	if(typeof deskName !== "string")
	{
		return "unknown";
	}
	const stored = normaliseName(storedName);
	if(stored === "")
	{
		return "first";
	}
	return stored === normaliseName(deskName) ? "same" : "changed";
}

/**
 * @param {unknown} storedName
 * @param {unknown} deskName
 * @returns {boolean}
 */
function isChanged(storedName, deskName)
{
	return nameStatus(storedName, deskName) === "changed";
}

/**
 * The colour to show for an aux. An unset colour, or a colour that is still the automatic
 * colour of the previous name, follows the desk name (its default colour).
 * @param {{colour?: string, name?: string}|undefined} slot - the aux's state.json entry
 * @param {string|undefined} deskName - the aux name the desk reports
 * @param {string} defaultColour - this aux's automatic colour (colour.assignColours over all auxes)
 * @returns {string}
 */
function effectiveAuxColour(slot, deskName, defaultColour)
{
	const stored = slot?.colour;
	if(typeof stored !== "string" || stored.trim() === "")
	{
		return defaultColour;
	}
	if(isChanged(slot?.name, deskName) && sameColour(stored, colourForName(slot?.name)))
	{
		return defaultColour;
	}
	return stored;
}

/**
 * Work out whether a device lock is suspended.
 * @param {{aux: number, auxName?: string}} lock
 * @param {string|undefined} deskName - the name the desk reports for the locked aux (undefined if the aux doesn't exist)
 * @returns {{suspended: boolean, auxName: string}}
 */
function lockState(lock, deskName)
{
	if(typeof deskName !== "string")
	{
		return {suspended: true, auxName: ""};
	}
	return {suspended: isChanged(lock.auxName, deskName), auxName: deskName};
}

/**
 * List the slots whose identity changed and hasn't been confirmed.
 * @param {object} params
 * @param {number} params.auxCount
 * @param {number} params.channelCount
 * @param {(aux: number) => (string|undefined)} params.auxName - desk name for a 1-based aux
 * @param {(channel: number) => (string|undefined)} params.channelName - desk name for a 1-based channel
 * @param {{auxes?: object[], channels?: object[]}} params.state - current state.json
 * @param {Object<string, {aux: number, auxName?: string}>} [params.locks] - device locks
 * @returns {{type: "aux"|"channel", number: number, previousName: string, currentName: string, movedFrom: number|null}[]}
 */
function identityChanges({auxCount, channelCount, auxName, channelName, state, locks = {}})
{
	const changes = [];
	const auxMoves = new Map(findMoves({count: auxCount, deskName: auxName, slots: state?.auxes}).map(move => [move.to, move.from]));
	const channelMoves = new Map(findMoves({count: channelCount, deskName: channelName, slots: state?.channels}).map(move => [move.to, move.from]));
	for(let aux = 1; aux <= auxCount; aux++)
	{
		const current = auxName(aux);
		if(typeof current !== "string")
		{
			continue;
		}
		const stored = state?.auxes?.[aux - 1]?.name;
		let previous = isChanged(stored, current) || auxMoves.has(aux) ? (stored ?? "") : null;
		if(previous === null)
		{
			const lock = Object.values(locks).find(l => l && l.aux === aux && isChanged(l.auxName, current));
			previous = lock ? lock.auxName : null;
		}
		if(previous !== null)
		{
			changes.push({type: "aux", number: aux, previousName: previous, currentName: current, movedFrom: auxMoves.get(aux) ?? null});
		}
	}
	for(let channel = 1; channel <= channelCount; channel++)
	{
		const current = channelName(channel);
		const stored = state?.channels?.[channel - 1]?.name;
		if(typeof current === "string" && (isChanged(stored, current) || channelMoves.has(channel)))
		{
			changes.push({type: "channel", number: channel, previousName: stored ?? "", currentName: current, movedFrom: channelMoves.get(channel) ?? null});
		}
	}
	return changes;
}

/**
 * Build the confirmed state.json entry for a slot.
 * @param {"aux"|"channel"} type
 * @param {object|undefined} slot - the current entry
 * @param {string} deskName - the name being accepted
 * @param {boolean} keepSettings - keep colour/icon/title/group, or reset them
 * @param {number} index - 0-based slot index (for the colour fallback)
 * @param {number} total - number of slots of this type (for the colour fallback)
 * @returns {object} the new entry
 */
function confirmSlot(type, slot, deskName, keepSettings, index, total)
{
	const enabled = slot?.enabled ?? true;
	if(keepSettings)
	{
		const next = {...(slot || {enabled}), name: deskName};
		if(type === "aux" && typeof next.colour === "string" && sameColour(next.colour, colourForName(slot?.name, index, total)))
		{
			next.colour = ""; //was the old name's automatic colour - keep following the name
		}
		return next;
	}
	if(type === "aux")
	{
		return {enabled, colour: "", icon: "", name: deskName};
	}
	const next = {enabled, title: "", icon: "", group: "", name: deskName};
	if(slot && slot.displayOrder !== undefined)
	{
		next.displayOrder = slot.displayOrder;
	}
	return next;
}

/**
 * Find auxes or channels that moved to another number on the desk (a restructure inserted or
 * removed slots, so everything after it shifted). A slot M counts as "moved from N" when M's
 * desk name differs from what is stored for M, and that desk name matches the stored name of
 * exactly one slot N != M and appears on exactly one slot of the desk. Anything ambiguous
 * (duplicate names, empty names) is left for the engineer to confirm by hand.
 * @param {object} params
 * @param {number} params.count - number of slots on the desk
 * @param {(n: number) => (string|undefined)} params.deskName - desk name for a 1-based slot
 * @param {object[]} [params.slots] - state.json entries (0-based), each may have `name`
 * @returns {{from: number, to: number, name: string}[]}
 */
function findMoves({count, deskName, slots = []})
{
	const deskByName = new Map();
	for(let n = 1; n <= count; n++)
	{
		const name = normaliseName(deskName(n));
		if(name)
		{
			deskByName.set(name, (deskByName.get(name) || []).concat(n));
		}
	}
	const storedByName = new Map();
	for(let i = 0; i < slots.length; i++)
	{
		const name = normaliseName(slots[i]?.name);
		if(name)
		{
			storedByName.set(name, (storedByName.get(name) || []).concat(i + 1));
		}
	}

	const moves = [];
	for(let to = 1; to <= count; to++)
	{
		const current = deskName(to);
		//a slot never seen before (no stored name) can also be where something moved to
		if(typeof current !== "string" || normaliseName(slots[to - 1]?.name) === normaliseName(current))
		{
			continue;
		}
		const name = normaliseName(current);
		const onDesk = deskByName.get(name) || [];
		const stored = storedByName.get(name) || [];
		if(onDesk.length === 1 && stored.length === 1 && stored[0] !== to)
		{
			moves.push({from: stored[0], to, name: current});
		}
	}
	return moves;
}

/**
 * Settings for a slot whose previous occupant moved away and that nothing moved into: a new
 * aux/channel, so it starts from defaults (and is taken as confirmed under its desk name).
 * @param {"aux"|"channel"} type
 * @param {number} number - 1-based
 * @param {string|undefined} deskName
 * @returns {object}
 */
function freshSlot(type, number, deskName)
{
	const name = typeof deskName === "string" ? deskName : "";
	if(type === "aux")
	{
		return {enabled: true, colour: "", icon: "", name};
	}
	return {enabled: true, title: "", icon: "", group: "", displayOrder: number - 1, name};
}

/**
 * Move state.json entries to follow moved slots.
 * @param {"aux"|"channel"} type
 * @param {object[]} slots - current entries (0-based); not modified
 * @param {{from: number, to: number}[]} moves - from findMoves()
 * @param {(n: number) => (string|undefined)} deskName
 * @returns {object[]} new entries
 */
function applyMovesToSlots(type, slots, moves, deskName)
{
	const next = (slots || []).map(slot => (slot && typeof slot === "object") ? {...slot} : slot);
	const destinations = new Set(moves.map(move => move.to));
	for(const move of moves)
	{
		const from = slots?.[move.from - 1];
		next[move.to - 1] = {...((from && typeof from === "object") ? from : {enabled: true}), name: deskName(move.to) ?? move.name};
	}
	for(const move of moves)
	{
		if(!destinations.has(move.from))
		{
			next[move.from - 1] = freshSlot(type, move.from, deskName(move.from));
		}
	}
	for(let i = 0; i < next.length; i++)
	{
		if(!next[i] || typeof next[i] !== "object")
		{
			next[i] = {enabled: true};
		}
	}
	return next;
}

/**
 * Renumber something keyed or listed by slot number: moved numbers follow their move, numbers
 * that something else moved into (and that didn't move themselves) belonged to the previous
 * occupant and are dropped.
 * @param {{from: number, to: number}[]} moves
 * @returns {(n: number) => (number|null)}
 */
function renumberer(moves)
{
	const map = new Map(moves.map(move => [move.from, move.to]));
	const destinations = new Set(moves.map(move => move.to));
	return n =>
	{
		if(map.has(n))
		{
			return map.get(n);
		}
		return destinations.has(n) ? null : n;
	};
}

/**
 * Follow moved auxes in the per-aux channel layouts ({aux: {order, hidden}}).
 * @param {Object<string, {order: number[], hidden: number[]}>} layouts
 * @param {{from: number, to: number}[]} moves
 * @returns {Object<string, {order: number[], hidden: number[]}>}
 */
function moveAuxLayouts(layouts, moves)
{
	const renumber = renumberer(moves);
	const next = {};
	for(const [key, layout] of Object.entries(layouts || {}))
	{
		const to = renumber(Number(key));
		if(to !== null)
		{
			next[to] = layout;
		}
	}
	return next;
}

/**
 * Follow moved channels inside every aux layout (channel numbers in order/hidden).
 * @param {Object<string, {order: number[], hidden: number[]}>} layouts
 * @param {{from: number, to: number}[]} moves
 * @returns {Object<string, {order: number[], hidden: number[]}>}
 */
function moveChannelsInLayouts(layouts, moves)
{
	const renumber = renumberer(moves);
	const remap = list => [...new Set((Array.isArray(list) ? list : []).map(n => renumber(Number(n))).filter(n => n !== null))];
	const next = {};
	for(const [key, layout] of Object.entries(layouts || {}))
	{
		next[key] = {...layout, order: remap(layout?.order), hidden: remap(layout?.hidden)};
	}
	return next;
}

/**
 * Follow moved auxes in the device locks: a lock moves with its aux and takes its desk name.
 * Locks on other auxes are unchanged (a lock on an aux that something moved into stays
 * suspended until confirmed, because its musician's mix went somewhere else).
 * @param {Object<string, {aux: number, auxName?: string}>} locks
 * @param {{from: number, to: number, name: string}[]} moves
 * @returns {{locks: Object<string, object>, moved: string[]}}
 */
function moveLocks(locks, moves)
{
	const byFrom = new Map(moves.map(move => [move.from, move]));
	const next = {};
	const moved = [];
	for(const [id, lock] of Object.entries(locks || {}))
	{
		const move = lock ? byFrom.get(lock.aux) : undefined;
		if(move && !isChanged(lock.auxName, move.name))
		{
			next[id] = {...lock, aux: move.to, auxName: move.name};
			moved.push(id);
		}
		else
		{
			next[id] = lock;
		}
	}
	return {locks: next, moved};
}

module.exports = {
	nameStatus,
	isChanged,
	effectiveAuxColour,
	lockState,
	identityChanges,
	confirmSlot,
	findMoves,
	applyMovesToSlots,
	moveAuxLayouts,
	moveChannelsInLayouts,
	moveLocks
};
