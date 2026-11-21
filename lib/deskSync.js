"use strict";

/**
 * What to ask the desk for, and how fast.
 *
 *  - nextLoadQuery(): the single query that the initial load is waiting for (channel count,
 *    aux modes, aux names, channel names, in that order), or null when loading is complete.
 *  - wantedQueries(): after loading, everything that is missing or stale (names of new
 *    channels/auxes, send levels and pans), bounded by what the desk actually has.
 *  - createQueryPacer(): sends a few queries per tick, retries unanswered ones and gives up
 *    after a few attempts (a channel the desk doesn't answer for is not retried forever).
 *
 * This module is pure (cache passed in, clock injectable) so it can be unit tested.
 */

const CHANNEL_COUNT = "/Console/Input_Channels";
const AUX_MODES = "/Console/Aux_Outputs/modes";

const auxNameAddress = aux => `/Aux_Outputs/${aux}/Buss_Trim/name`;
const channelNameAddress = channel => `/Input_Channels/${channel}/Channel_Input/name`;
const sendAddress = (channel, aux, param) => `/Input_Channels/${channel}/Aux_Send/${aux}/send_${param}`;

/** Upper bound for channel/aux numbers, matching the \d{1,3} address patterns. */
const MAX_SLOTS = 999;

/**
 * @param {Map<string, {args: any[]}>} cache
 * @returns {number} the desk's input channel count (0 when unknown)
 */
function channelCount(cache)
{
	const count = Number(cache.get(CHANNEL_COUNT)?.args?.[0]);
	return Number.isInteger(count) && count > 0 ? Math.min(count, MAX_SLOTS) : 0;
}

/**
 * @param {Map<string, {args: any[]}>} cache
 * @returns {number} the desk's aux count (0 when unknown)
 */
function auxCount(cache)
{
	const modes = cache.get(AUX_MODES)?.args;
	return Array.isArray(modes) ? Math.min(modes.length, MAX_SLOTS) : 0;
}

/**
 * The query the initial load needs next.
 * @param {Map<string, {args: any[]}>} cache
 * @returns {string|null} a query address (ending in "/?"), or null when everything required is cached
 */
function nextLoadQuery(cache)
{
	if(!cache.has(CHANNEL_COUNT))
	{
		return "/Console/Channels/?"; //answered with the channel count (among other things)
	}
	if(!cache.has(AUX_MODES))
	{
		return AUX_MODES + "/?";
	}
	for(let aux = 1; aux <= auxCount(cache); aux++)
	{
		if(!cache.has(auxNameAddress(aux)))
		{
			return auxNameAddress(aux) + "/?";
		}
	}
	for(let channel = 1; channel <= channelCount(cache); channel++)
	{
		if(!cache.has(channelNameAddress(channel)))
		{
			return channelNameAddress(channel) + "/?";
		}
	}
	return null;
}

/**
 * Everything that should be (re)requested from the desk after loading, most important first.
 * @param {Map<string, {args: any[]}>} cache
 * @param {object} options
 * @param {(channel: number) => boolean} options.channelEnabled - 1-based channel
 * @param {(aux: number) => boolean} options.auxEnabled - 1-based aux
 * @param {Set<string>} [options.stale] - addresses whose cached value must be refreshed
 * @returns {string[]} query addresses (ending in "/?")
 */
function wantedQueries(cache, {channelEnabled, auxEnabled, stale = new Set()})
{
	const wanted = [];
	const want = address => !cache.has(address) || stale.has(address);
	const channels = channelCount(cache);
	const auxes = auxCount(cache);

	for(const address of [CHANNEL_COUNT, AUX_MODES])
	{
		if(stale.has(address))
		{
			wanted.push(address === CHANNEL_COUNT ? "/Console/Channels/?" : AUX_MODES + "/?");
		}
	}
	for(let aux = 1; aux <= auxes; aux++)
	{
		if(want(auxNameAddress(aux)))
		{
			wanted.push(auxNameAddress(aux) + "/?");
		}
	}
	for(let channel = 1; channel <= channels; channel++)
	{
		if(want(channelNameAddress(channel)))
		{
			wanted.push(channelNameAddress(channel) + "/?");
		}
	}
	for(let aux = 1; aux <= auxes; aux++)
	{
		if(!auxEnabled(aux))
		{
			continue;
		}
		for(let channel = 1; channel <= channels; channel++)
		{
			if(!channelEnabled(channel))
			{
				continue;
			}
			for(const param of ["level", "pan"])
			{
				const address = sendAddress(channel, aux, param);
				if(want(address))
				{
					wanted.push(address + "/?");
				}
			}
		}
	}
	return wanted;
}

/**
 * @param {{perTick?: number, retryMs?: number, maxAttempts?: number, now?: () => number}} [options]
 */
function createQueryPacer(options = {})
{
	const perTick = options.perTick ?? 4;
	const retryMs = options.retryMs ?? 1500;
	const maxAttempts = options.maxAttempts ?? 3;
	const now = options.now ?? Date.now;

	/** @type {Map<string, {attempts: number, at: number}>} */
	const tries = new Map();

	return {
		/**
		 * Choose which of the wanted queries to send now.
		 * @param {string[]} wanted
		 * @returns {{send: string[], done: boolean}} done = nothing left that will ever be sent
		 */
		pick(wanted)
		{
			const time = now();
			const send = [];
			let pending = false;
			for(const address of wanted)
			{
				const entry = tries.get(address);
				if(entry && entry.attempts >= maxAttempts)
				{
					continue; //given up on this one
				}
				pending = true;
				if(send.length >= perTick || (entry && time - entry.at < retryMs))
				{
					continue;
				}
				tries.set(address, {attempts: (entry ? entry.attempts : 0) + 1, at: time});
				send.push(address);
			}
			return {send, done: !pending};
		},

		/**
		 * Forget the attempts for an address, e.g. because it was answered or must be refreshed again.
		 * @param {string} address - query address
		 */
		forget(address)
		{
			tries.delete(address);
		},

		/**
		 * @param {string} address - query address
		 * @returns {boolean} true if the pacer gave up on this query
		 */
		gaveUp(address)
		{
			const entry = tries.get(address);
			return Boolean(entry && entry.attempts >= maxAttempts);
		},

		reset()
		{
			tries.clear();
		}
	};
}

module.exports = {
	CHANNEL_COUNT,
	AUX_MODES,
	auxNameAddress,
	channelNameAddress,
	sendAddress,
	channelCount,
	auxCount,
	nextLoadQuery,
	wantedQueries,
	createQueryPacer
};
