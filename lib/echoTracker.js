"use strict";

/**
 * Remembers the values recently sent to the desk, so that the desk echoing them back can be
 * recognised and ignored (instead of being broadcast to every client, which makes faders jump
 * back to an older value while someone is moving them).
 *
 * Only the desk's echoes are suppressed; commands from clients are always forwarded.
 *
 * This module is pure (the clock is injectable) so it can be unit tested.
 */

const DEFAULT_WINDOW_MS = 1500;
const DEFAULT_TOLERANCE = 0.01;
const MAX_VALUES_PER_ADDRESS = 32;
const MAX_ADDRESSES = 5000;

/**
 * @param {unknown} a
 * @param {unknown} b
 * @param {number} tolerance
 * @returns {boolean}
 */
function argsMatch(a, b, tolerance)
{
	if(!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
	{
		return false;
	}
	for(let i = 0; i < a.length; i++)
	{
		const x = a[i], y = b[i];
		if(typeof x === "number" && typeof y === "number")
		{
			if(!(Math.abs(x - y) <= tolerance))
			{
				return false;
			}
		}
		else if(x !== y)
		{
			return false;
		}
	}
	return true;
}

/**
 * @param {{windowMs?: number, tolerance?: number, now?: () => number}} [options]
 */
function createEchoTracker(options = {})
{
	const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
	const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
	const now = options.now ?? Date.now;

	/** @type {Map<string, {args: any[], at: number}[]>} */
	const sent = new Map();

	function prune(address, time)
	{
		const list = sent.get(address);
		if(!list)
		{
			return [];
		}
		const fresh = list.filter(entry => time - entry.at <= windowMs);
		if(fresh.length === 0)
		{
			sent.delete(address);
		}
		else if(fresh.length !== list.length)
		{
			sent.set(address, fresh);
		}
		return fresh;
	}

	function pruneAll(time)
	{
		for(const address of [...sent.keys()])
		{
			prune(address, time);
		}
	}

	return {
		/**
		 * Remember that a value was sent to the desk.
		 * @param {string} address
		 * @param {any[]} args
		 */
		record(address, args)
		{
			if(typeof address !== "string" || address.endsWith("/?"))
			{
				return;
			}
			const time = now();
			const list = prune(address, time);
			list.push({args: Array.isArray(args) ? args.slice() : [], at: time});
			if(list.length > MAX_VALUES_PER_ADDRESS)
			{
				list.splice(0, list.length - MAX_VALUES_PER_ADDRESS);
			}
			sent.set(address, list);
			if(sent.size > MAX_ADDRESSES)
			{
				pruneAll(time);
			}
		},

		/**
		 * Is this desk message an echo of something sent recently? The oldest matching entry is
		 * consumed together with every older entry for that address (the desk answers in order,
		 * and an echo that went missing on the network is no longer expected).
		 * @param {string} address
		 * @param {any[]} args
		 * @returns {boolean}
		 */
		isEcho(address, args)
		{
			const list = prune(address, now());
			for(let i = 0; i < list.length; i++)
			{
				if(argsMatch(list[i].args, args, tolerance))
				{
					list.splice(0, i + 1);
					if(list.length === 0)
					{
						sent.delete(address);
					}
					return true;
				}
			}
			return false;
		},

		/**
		 * Is a value for this address still in flight (sent within the window)?
		 * @param {string} address
		 * @returns {boolean}
		 */
		hasPending(address)
		{
			return prune(address, now()).length > 0;
		},

		clear()
		{
			sent.clear();
		},

		get size()
		{
			return sent.size;
		}
	};
}

module.exports = {
	createEchoTracker,
	argsMatch,
	DEFAULT_WINDOW_MS
};
