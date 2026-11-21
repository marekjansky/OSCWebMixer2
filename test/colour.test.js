"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { colourForName, hslToHex, normaliseName, sameColour } = require("../lib/colour.js");
const { generateColour } = require("../lib/utils/utils.js");

/** WCAG relative luminance of a #rrggbb colour */
function luminance(hex)
{
	const channel = i => {
		const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** contrast ratio between two colours */
function contrast(a, b)
{
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

test("same name gives the same colour, ignoring case and surrounding/inner whitespace", () =>
{
	const colour = colourForName("Lead Vox");
	assert.equal(colourForName("lead vox"), colour);
	assert.equal(colourForName("  LEAD   VOX "), colour);
	assert.match(colour, /^#[0-9a-f]{6}$/);
});

test("different names usually give different colours", () =>
{
	const names = ["Drums IEM", "Bass IEM", "Gtr IEM", "Keys IEM", "Vox IEM", "MD Mix", "Wedge 1", "Wedge 2"];
	const colours = new Set(names.map(name => colourForName(name)));
	assert.ok(colours.size >= 6, `only ${colours.size} distinct colours for ${names.length} names`);
	assert.notEqual(colourForName("Vox 1"), colourForName("Vox 2"));
});

test("hues are well spread over many names", () =>
{
	const buckets = new Array(6).fill(0);
	for(let i = 0; i < 600; i++)
	{
		const hex = colourForName(`Musician ${i}`);
		const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
		const max = Math.max(r, g, b), min = Math.min(r, g, b);
		let hue;
		if(max === r) hue = ((g - b) / (max - min) + 6) % 6;
		else if(max === g) hue = (b - r) / (max - min) + 2;
		else hue = (r - g) / (max - min) + 4;
		buckets[Math.floor(hue)]++;
	}
	for(const count of buckets)
	{
		assert.ok(count > 50 && count < 150, `uneven hue spread: ${buckets.join(",")}`);
	}
});

test("every generated colour keeps white text readable and stands out from a black background", () =>
{
	for(let i = 0; i < 1000; i++)
	{
		const colour = colourForName(`Name ${i}`);
		assert.ok(contrast(colour, "#ffffff") >= 4, `${colour} too light for white text`);
		assert.ok(contrast(colour, "#000000") >= 2, `${colour} too dark on black`);
	}
});

test("empty or missing names fall back to the index based colour", () =>
{
	assert.equal(colourForName("", 2, 8), generateColour(8, 2).toLowerCase());
	assert.equal(colourForName("   ", 0, 4), generateColour(4, 0).toLowerCase());
	assert.equal(colourForName(undefined, 1, 4), generateColour(4, 1).toLowerCase());
	//bad index/total doesn't throw
	assert.match(colourForName("", 99, 4), /^#[0-9a-f]{6}$/);
	assert.match(colourForName("", -1, 0), /^#[0-9a-f]{6}$/);
});

test("hslToHex converts known colours", () =>
{
	assert.equal(hslToHex(0, 100, 50), "#ff0000");
	assert.equal(hslToHex(120, 100, 50), "#00ff00");
	assert.equal(hslToHex(240, 100, 50), "#0000ff");
	assert.equal(hslToHex(0, 0, 100), "#ffffff");
});

test("normaliseName and sameColour", () =>
{
	assert.equal(normaliseName("  A  b "), "a b");
	assert.equal(normaliseName(null), "");
	assert.ok(sameColour("#AABBCC", " #aabbcc"));
	assert.ok(!sameColour("#aabbcc", undefined));
});
