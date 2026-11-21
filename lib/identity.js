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
 * colour of the previous name, follows the desk name.
 * @param {{colour?: string, name?: string}|undefined} slot - the aux's state.json entry
 * @param {string|undefined} deskName - the aux name the desk reports
 * @param {number} index - 0-based aux index
 * @param {number} total - number of auxes
 * @returns {string}
 */
function effectiveAuxColour(slot, deskName, index, total)
{
	const name = typeof deskName === "string" ? deskName : slot?.name;
	const stored = slot?.colour;
	if(typeof stored !== "string" || stored.trim() === "")
	{
		return colourForName(name, index, total);
	}
	if(isChanged(slot?.name, deskName) && sameColour(stored, colourForName(slot?.name, index, total)))
	{
		return colourForName(deskName, index, total);
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
 * @returns {{type: "aux"|"channel", number: number, previousName: string, currentName: string}[]}
 */
function identityChanges({auxCount, channelCount, auxName, channelName, state, locks = {}})
{
	const changes = [];
	for(let aux = 1; aux <= auxCount; aux++)
	{
		const current = auxName(aux);
		if(typeof current !== "string")
		{
			continue;
		}
		const stored = state?.auxes?.[aux - 1]?.name;
		let previous = isChanged(stored, current) ? stored : null;
		if(previous === null)
		{
			const lock = Object.values(locks).find(l => l && l.aux === aux && isChanged(l.auxName, current));
			previous = lock ? lock.auxName : null;
		}
		if(previous !== null)
		{
			changes.push({type: "aux", number: aux, previousName: previous, currentName: current});
		}
	}
	for(let channel = 1; channel <= channelCount; channel++)
	{
		const current = channelName(channel);
		const stored = state?.channels?.[channel - 1]?.name;
		if(typeof current === "string" && isChanged(stored, current))
		{
			changes.push({type: "channel", number: channel, previousName: stored, currentName: current});
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

module.exports = {
	nameStatus,
	isChanged,
	effectiveAuxColour,
	lockState,
	identityChanges,
	confirmSlot
};
