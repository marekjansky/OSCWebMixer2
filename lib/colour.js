"use strict";

/**
 * Default aux colours derived from the aux NAME, so the same musician keeps the same colour
 * across sessions and aux renumbering, and a different name gets a different colour.
 *
 * The colours are used as backgrounds behind white text on a dark UI, so they are fairly
 * saturated and kept dark enough for white text (yellows/greens/cyans, which look much
 * brighter at the same HSL lightness, are made darker).
 *
 * This module is pure so it can be unit tested.
 */

const { generateColour } = require("./utils/utils.js");

/** Number of distinct hues. 10 degree steps are far enough apart to tell apart on stage. */
const HUE_STEPS = 36;

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

/** Contrast wanted between white text and the colour (WCAG AA for normal text). */
const WHITE_TEXT_CONTRAST = 4.5;
const START_LIGHTNESS = 55;
const MIN_LIGHTNESS = 20;

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
 * The lightest colour of this hue/saturation that white text is still readable on (hues
 * that look bright - yellow, green, cyan - end up darker than blues and purples).
 * @param {number} hue
 * @param {number} saturation
 * @returns {string} #rrggbb
 */
function readableColour(hue, saturation)
{
	let hex = hslToHex(hue, saturation, START_LIGHTNESS);
	for(let lightness = START_LIGHTNESS; lightness >= MIN_LIGHTNESS; lightness--)
	{
		hex = hslToHex(hue, saturation, lightness);
		if(1.05 / (relativeLuminance(hex) + 0.05) >= WHITE_TEXT_CONTRAST)
		{
			break;
		}
	}
	return hex;
}

/**
 * The default colour for a named aux.
 * @param {unknown} name - the aux name from the desk
 * @param {number} [index] - 0-based aux index, used for the fallback when the name is empty
 * @param {number} [total] - number of auxes, used for the fallback when the name is empty
 * @returns {string} #rrggbb
 */
function colourForName(name, index = 0, total = 16)
{
	const normalised = normaliseName(name);
	if(normalised === "")
	{
		const safeTotal = Number.isInteger(total) && total > 0 ? total : 16;
		const safeIndex = Number.isInteger(index) && index >= 0 && index < safeTotal ? index : 0;
		return generateColour(safeTotal, safeIndex).toLowerCase();
	}

	const hash = hashString(normalised);
	const hue = (hash % HUE_STEPS) * (360 / HUE_STEPS);
	const saturation = ((hash >>> 8) & 1) ? 65 : 55;
	return readableColour(hue, saturation);
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
	sameColour
};
