"use strict";

/**
 * Group trims ("virtual VCAs"): a group fader on a webmixer aux moves the aux send of every
 * member channel by the same number of dB.
 *
 * When a member hits the -150 dB floor or the +10 dB ceiling its send is clamped, but the
 * unclamped ("virtual") value is remembered, so pulling a group all the way down and back up
 * restores the original balance. The virtual value is dropped as soon as anything else moves
 * that send (see the callers in index.js).
 *
 * This module is pure so it can be unit tested.
 */

const MIN_DB = -150;
const MAX_DB = 10;
const UNITY_DB = 0;

const GROUP_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Largest increase a single group message may make. A fader dragged upwards sends many small
 * steps; one big jump (a tap on the track, a glitching client) is limited and the sender is
 * told the real level. Decreases are never limited.
 */
const MAX_STEP_UP_DB = 20;

/**
 * Below this level a group is so quiet that big dB jumps are inaudible (the bottom of a fader
 * covers -150..-60 dB in a few millimetres), so the step limit counts from here.
 */
const STEP_FLOOR_DB = -60;

/**
 * Clamp a send level to the range the desk accepts. Non numbers become the floor.
 * @param {unknown} db
 * @returns {number}
 */
function clampDb(db)
{
	const value = Number(db);
	if(!Number.isFinite(value))
	{
		return MIN_DB;
	}
	return Math.min(MAX_DB, Math.max(MIN_DB, value));
}

/**
 * Apply a group trim to one member send.
 * @param {number} currentDb - the send level the desk currently has
 * @param {number|undefined|null} virtualDb - the remembered unclamped level from earlier trims, if any
 * @param {number} deltaDb - how far the group fader moved
 * @returns {{sendDb: number, virtualDb: number|null}} the level to send, and the unclamped
 * level to remember (null when the send isn't clamped)
 */
function applyTrim(currentDb, virtualDb, deltaDb)
{
	const base = (typeof virtualDb === "number" && Number.isFinite(virtualDb)) ? virtualDb : clampDb(currentDb);
	const target = base + deltaDb;
	const sendDb = clampDb(target);
	return {
		sendDb: sendDb,
		virtualDb: sendDb === target ? null : target
	};
}

/**
 * Limit how far a single message may raise a group fader.
 * @param {number} currentDb - the group's current level
 * @param {number} requestedDb - the (already clamped) level asked for
 * @returns {number} the level to apply
 */
function limitGroupMove(currentDb, requestedDb)
{
	if(requestedDb <= currentDb)
	{
		return requestedDb;
	}
	return Math.min(requestedDb, Math.max(currentDb, STEP_FLOOR_DB) + MAX_STEP_UP_DB);
}

/**
 * Decide what to do with a group fader move.
 *
 * A move is rejected while any member's send level is unknown: skipping that member now and
 * trimming it later would apply the whole accumulated delta in one go (a sudden loud send).
 * @param {number} currentDb - the group's current level
 * @param {unknown} requested - the level the client asked for
 * @param {Map<number, number|undefined>} memberLevels - known send level per member channel
 *   (undefined when not known yet)
 * @returns {{action: "ignore"} | {action: "reject", missing: number[]} | {action: "apply", levelDb: number, deltaDb: number, limited: boolean}}
 */
function planGroupMove(currentDb, requested, memberLevels)
{
	if(typeof requested !== "number" || !Number.isFinite(requested))
	{
		return {action: "ignore"};
	}
	const missing = [...memberLevels].filter(([, level]) => typeof level !== "number" || !Number.isFinite(level)).map(([channel]) => channel);
	if(missing.length > 0)
	{
		return {action: "reject", missing};
	}
	const wanted = clampDb(requested);
	const levelDb = limitGroupMove(currentDb, wanted);
	return {action: "apply", levelDb, deltaDb: levelDb - currentDb, limited: levelDb !== wanted};
}

/**
 * @param {unknown} id
 * @returns {boolean}
 */
function isValidGroupId(id)
{
	return typeof id === "string" && GROUP_ID_PATTERN.test(id);
}

/**
 * Parse a webmixer group address: /Webmixer/Aux/{aux}/Group/{groupId}/level[/?]
 * @param {string} address
 * @returns {{aux: number, groupId: string, query: boolean}|null}
 */
function parseGroupAddress(address)
{
	if(typeof address !== "string")
	{
		return null;
	}
	const match = address.match(/^\/Webmixer\/Aux\/(\d{1,3})\/Group\/([A-Za-z0-9_-]{1,64})\/level(\/\?)?$/);
	if(!match)
	{
		return null;
	}
	return {
		aux: parseInt(match[1], 10),
		groupId: match[2],
		query: match[3] !== undefined
	};
}

/**
 * Build the group address for an aux
 * @param {number} aux
 * @param {string} groupId
 * @returns {string}
 */
function groupAddress(aux, groupId)
{
	return `/Webmixer/Aux/${aux}/Group/${groupId}/level`;
}

/**
 * Find the member channels of a group.
 * @param {{group?: string}[]|undefined} channelsState - currentState.channels (index 0 = channel 1)
 * @param {string} groupId
 * @param {(channel: number) => boolean} [include] - optional filter on 1-based channel numbers
 *   (index.js passes "enabled and on the desk": hidden channels are not trimmed)
 * @returns {number[]} 1-based channel numbers
 */
function groupMembers(channelsState, groupId, include = () => true)
{
	let members = [];
	if(!Array.isArray(channelsState))
	{
		return members;
	}
	for(const [index, channel] of channelsState.entries())
	{
		if(channel && channel.group === groupId && include(index + 1))
		{
			members.push(index + 1);
		}
	}
	return members;
}

module.exports = {
	MIN_DB,
	MAX_DB,
	UNITY_DB,
	MAX_STEP_UP_DB,
	STEP_FLOOR_DB,
	clampDb,
	limitGroupMove,
	planGroupMove,
	applyTrim,
	isValidGroupId,
	parseGroupAddress,
	groupAddress,
	groupMembers
};
