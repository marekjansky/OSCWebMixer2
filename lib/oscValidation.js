"use strict";

/**
 * Validation of OSC messages arriving from webmixer sockets and external devices, so that a
 * buggy or malicious client can't send the desk NaN/Infinity, out of range levels, OSC wildcard
 * addresses ("/Input_Channels/*" would address every channel) or anything other than an aux send.
 *
 * This module is pure so it can be unit tested.
 */

const MIN_LEVEL_DB = -150;
const MAX_LEVEL_DB = 10;
const MIN_PAN = 0;
const MAX_PAN = 1;

const MAX_ADDRESS_LENGTH = 256;
const MAX_ARGS = 16;
const MAX_STRING_LENGTH = 256;

/**
 * Plain OSC address: segments of letters, digits, "_", "-", "." or "!", optionally ending
 * with "/?" (a query). OSC pattern characters (* ? [ ] { } ,), spaces and "#" are rejected.
 */
const SAFE_ADDRESS = /^(?:\/[A-Za-z0-9_.!-]+)+(?:\/\?)?$/;

const SEND_ADDRESS = /^\/Input_Channels\/(\d{1,3})\/Aux_Send\/(\d{1,3})\/send_(level|pan|on)(\/\?)?$/;

/**
 * @param {unknown} address
 * @returns {boolean}
 */
function isSafeAddress(address)
{
	return typeof address === "string" && address.length <= MAX_ADDRESS_LENGTH && SAFE_ADDRESS.test(address);
}

/**
 * @param {unknown} address
 * @returns {boolean} true for an address ending in "/?"
 */
function isQuery(address)
{
	return typeof address === "string" && address.endsWith("/?");
}

/**
 * Parse an aux send address.
 * @param {unknown} address
 * @returns {{channel: number, aux: number, param: "level"|"pan", query: boolean}|null}
 */
function parseSendAddress(address)
{
	const match = typeof address === "string" ? address.match(SEND_ADDRESS) : null;
	if(!match)
	{
		return null;
	}
	const channel = parseInt(match[1], 10);
	const aux = parseInt(match[2], 10);
	if(channel < 1 || aux < 1)
	{
		return null;
	}
	return {channel, aux, param: /** @type {"level"|"pan"} */ (match[3]), query: match[4] !== undefined};
}

/**
 * Check the argument list of a message.
 * @param {unknown} args
 * @returns {any[]|null} the args (undefined becomes []), or null if they are not acceptable
 */
function normaliseArgs(args)
{
	if(args === undefined || args === null)
	{
		return [];
	}
	if(!Array.isArray(args) || args.length > MAX_ARGS)
	{
		return null;
	}
	for(const arg of args)
	{
		if(typeof arg === "number")
		{
			if(!Number.isFinite(arg))
			{
				return null;
			}
		}
		else if(typeof arg === "string")
		{
			if(arg.length > MAX_STRING_LENGTH)
			{
				return null;
			}
		}
		else if(typeof arg !== "boolean")
		{
			return null;
		}
	}
	return args;
}

/**
 * Clamp a send value to the range the desk accepts.
 * @param {"level"|"pan"} param
 * @param {unknown} value
 * @returns {number|null} the clamped value, or null when it isn't a finite number
 */
function clampSendValue(param, value)
{
	//send on/off: only 0/1 (or true/false), sent to the desk as the integer 0 or 1
	if(param === "on")
	{
		if(value === true || value === 1)
		{
			return 1;
		}
		if(value === false || value === 0)
		{
			return 0;
		}
		return null;
	}
	if(typeof value !== "number" || !Number.isFinite(value))
	{
		return null;
	}
	if(param === "pan")
	{
		return Math.min(MAX_PAN, Math.max(MIN_PAN, value));
	}
	return Math.min(MAX_LEVEL_DB, Math.max(MIN_LEVEL_DB, value));
}

/**
 * Validate a message from a webmixer socket. Sockets may query anything with a plain address,
 * but may only SET aux send levels, pans and on/off switches.
 * @param {{address?: unknown, args?: unknown}} msg
 * @returns {{ok: true, msg: {address: string, args: any[]}} | {ok: false, reason: string}}
 */
function sanitizeClientMessage(msg)
{
	if(!msg || typeof msg !== "object" || !isSafeAddress(msg.address))
	{
		return {ok: false, reason: "invalid address"};
	}
	const address = /** @type {string} */ (msg.address);
	const args = normaliseArgs(msg.args);
	if(args === null)
	{
		return {ok: false, reason: "invalid arguments"};
	}

	if(isQuery(address))
	{
		return {ok: true, msg: {address, args: []}};
	}

	const send = parseSendAddress(address);
	if(!send)
	{
		return {ok: false, reason: "address not allowed"};
	}
	if(args.length !== 1)
	{
		return {ok: false, reason: "expected one value"};
	}
	const value = clampSendValue(send.param, args[0]);
	if(value === null)
	{
		return {ok: false, reason: "value is not a finite number"};
	}
	return {ok: true, msg: {address, args: [value]}};
}

/**
 * Validate a message from an external OSC device. External devices may use any address
 * (plugins translate them), but aux send values must be finite and are clamped.
 * @param {{address?: unknown, args?: unknown}} msg
 * @returns {{address: string, args: any[]}|null} the (possibly clamped) message, or null to drop it
 */
function sanitizeExternalMessage(msg)
{
	if(!msg || typeof msg.address !== "string" || msg.address.length > MAX_ADDRESS_LENGTH)
	{
		return null;
	}
	const args = Array.isArray(msg.args) ? msg.args : [];
	const send = parseSendAddress(msg.address);
	if(!send || send.query)
	{
		return msg.args === args ? msg : {...msg, args};
	}
	if(args.length !== 1)
	{
		return null;
	}
	const value = clampSendValue(send.param, args[0]);
	if(value === null)
	{
		return null;
	}
	return value === args[0] ? msg : {...msg, args: [value]};
}

module.exports = {
	MIN_LEVEL_DB,
	MAX_LEVEL_DB,
	MIN_PAN,
	MAX_PAN,
	isSafeAddress,
	isQuery,
	parseSendAddress,
	normaliseArgs,
	clampSendValue,
	sanitizeClientMessage,
	sanitizeExternalMessage
};
