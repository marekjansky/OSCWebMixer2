"use strict";

/**
 * Default aux colours derived from the aux NAME, so the same musician keeps the same colour
 * across sessions and aux renumbering, and a different name gets a different colour.
 *
 * Colours come from a fixed palette of clearly different colours that white text is readable
 * on; assignColours() makes sure no two auxes share one.
 *
 * This module is pure so it can be unit tested.
 */

/**
 * 32-bit FNV-1a hash with a murmur3 finaliser so similar names ("Vox 1", "Vox 2") land far apart.
 * @param {string} text
 * @returns {number} unsigned 32-bit integer
 */
function hashString(text)
{
	let hash = 0x811c9dc5;
	for(const char of text)
	{
		hash ^= char.codePointAt(0);
		hash = Math.imul(hash, 0x01000193);
	}
	hash ^= hash >>> 16;
	hash = Math.imul(hash, 0x85ebca6b);
	hash ^= hash >>> 13;
	hash = Math.imul(hash, 0xc2b2ae35);
	hash ^= hash >>> 16;
	return hash >>> 0;
}

/**
 * Normalise a name for hashing: trimmed, case-insensitive, inner whitespace collapsed.
 * @param {unknown} name
 * @returns {string}
 */
function normaliseName(name)
{
	return typeof name === "string" ? name.trim().replace(/\s+/g, " ").toLowerCase() : "";
}

/**
 * Convert HSL (h in degrees, s and l in percent) to a lowercase #rrggbb string.
 * @param {number} h
 * @param {number} s
 * @param {number} l
 * @returns {string}
 */
function hslToHex(h, s, l)
{
	s /= 100;
	l /= 100;
	const k = n => (n + h / 30) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	const hex = x => Math.round(x * 255).toString(16).padStart(2, "0");
	return "#" + hex(f(0)) + hex(f(8)) + hex(f(4));
}

/**
 * WCAG relative luminance of a #rrggbb colour.
 * @param {string} hex
 * @returns {number} 0 (black) .. 1 (white)
 */
function relativeLuminance(hex)
{
	const channel = i => {
		const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/**
 * Default aux colours: 16 colours chosen to be clearly different from each other on stage
 * (closest pair about 17 apart in CIE Lab) and readable behind white text (contrast >= 4.4).
 * Random hues weren't: with 16 auxes, two of them almost always land on near-identical colours.
 */
const PALETTE = [
	"#d32f2f", // red
	"#1565c0", // blue
	"#2e7d32", // green
	"#8e24aa", // purple
	"#d84315", // orange
	"#00838f", // cyan
	"#c2185b", // pink
	"#6d4c41", // brown
	"#283593", // indigo
	"#827717", // olive
	"#455a64", // slate
	"#880e4f", // wine
	"#9a6700", // amber
	"#7e57c2", // lavender
	"#00695c", // teal
	"#0277bd"  // sky
];

/**
 * The palette colour a name prefers (the same name always prefers the same colour).
 * @param {unknown} name - the aux name from the desk
 * @param {number} [index] - 0-based aux index, used when the name is empty
 * @returns {number} index into PALETTE
 */
function preferredSlot(name, index = 0)
{
	const normalised = normaliseName(name);
	if(normalised === "")
	{
		return (Number.isInteger(index) && index >= 0 ? index : 0) % PALETTE.length;
	}
	return hashString(normalised) % PALETTE.length;
}

/**
 * The colour a name prefers on its own (before avoiding the other auxes' colours).
 * @param {unknown} name - the aux name from the desk
 * @param {number} [index] - 0-based aux index, used when the name is empty
 * @returns {string} #rrggbb
 */
function colourForName(name, index = 0)
{
	return PALETTE[preferredSlot(name, index)];
}

/**
 * Default colours for all auxes at once, so no two auxes share a colour: each aux (in desk
 * order) gets its name's preferred palette colour, or the next one no other aux has taken yet.
 * With more auxes than palette colours, the palette is reused once every colour is in use.
 * @param {unknown[]} names - desk names, 0-based by aux
 * @returns {string[]} #rrggbb per aux
 */
function assignColours(names)
{
	const colours = [];
	let used = new Set();
	for(let index = 0; index < names.length; index++)
	{
		if(used.size === PALETTE.length)
		{
			used = new Set();
		}
		let slot = preferredSlot(names[index], index);
		while(used.has(slot))
		{
			slot = (slot + 1) % PALETTE.length;
		}
		used.add(slot);
		colours.push(PALETTE[slot]);
	}
	return colours;
}

/**
 * Compare two colour strings ignoring case and surrounding whitespace.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function sameColour(a, b)
{
	return typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
}

module.exports = {
	hashString,
	normaliseName,
	hslToHex,
	relativeLuminance,
	colourForName,
	assignColours,
	PALETTE,
	sameColour
};
