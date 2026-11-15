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
 * @returns {number[]} 1-based channel numbers
 */
function groupMembers(channelsState, groupId)
{
	let members = [];
	if(!Array.isArray(channelsState))
	{
		return members;
	}
	for(const [index, channel] of channelsState.entries())
	{
		if(channel && channel.group === groupId)
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
	clampDb,
	applyTrim,
	isValidGroupId,
	parseGroupAddress,
	groupAddress,
	groupMembers
};
