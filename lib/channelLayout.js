"use strict";

/**
 * Channel layouts: the order and visibility of channels for an aux, set from the mixer's
 * "Arrange channels" mode and shared by every device on that aux.
 *
 * Message: /Webmixer/Aux/{aux}/Layout [json] where json is '{"order":[...],"hidden":[...]}'
 * (channel numbers), or no argument to go back to the admin layout.
 *
 * This module is pure (no sockets, no file access) so it can be unit tested.
 */

const MAX_CHANNEL = 999;

/**
 * @param {string} address
 * @returns {number|null} the aux number for a layout address, otherwise null
 */
function parseLayoutAddress(address)
{
	const match = typeof address === "string" ? address.match(/^\/Webmixer\/Aux\/(\d{1,3})\/Layout$/) : null;
	if(!match)
	{
		return null;
	}
	const aux = parseInt(match[1], 10);
	return aux > 0 ? aux : null;
}

/**
 * @param {number} aux
 * @returns {string}
 */
function layoutAddress(aux)
{
	return `/Webmixer/Aux/${aux}/Layout`;
}

/**
 * Turn a list into unique, valid channel numbers
 * @param {unknown} list
 * @returns {number[]}
 */
function channelList(list)
{
	if(!Array.isArray(list))
	{
		return [];
	}
	const channels = list
		.map(channel => Number(channel))
		.filter(channel => Number.isInteger(channel) && channel > 0 && channel <= MAX_CHANNEL);
	return [...new Set(channels)];
}

/**
 * Validate a layout sent by a client.
 * @param {unknown} value - a JSON string or object
 * @returns {{order: number[], hidden: number[]}|null} the clean layout, or null for "use the admin layout"
 */
function sanitizeLayout(value)
{
	let layout = value;
	if(typeof layout === "string")
	{
		try
		{
			layout = JSON.parse(layout);
		}
		catch(e)
		{
			return null;
		}
	}
	if(!layout || typeof layout !== "object" || Array.isArray(layout))
	{
		return null;
	}
	const order = channelList(layout.order);
	const hidden = channelList(layout.hidden);
	if(order.length === 0 && hidden.length === 0)
	{
		return null;
	}
	return { order, hidden };
}

module.exports = {
	parseLayoutAddress,
	layoutAddress,
	sanitizeLayout
};
