"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { colourForName, assignColours, PALETTE, hslToHex, normaliseName, sameColour } = require("../lib/colour.js");

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

test("every palette colour keeps white text readable and stands out from a black background", () =>
{
	for(const colour of PALETTE)
	{
		assert.ok(contrast(colour, "#ffffff") >= 4.4, `${colour} too light for white text`);
		assert.ok(contrast(colour, "#000000") >= 2, `${colour} too dark on black`);
	}
	assert.equal(new Set(PALETTE).size, 16);
});

test("empty or missing names use the aux position", () =>
{
	assert.equal(colourForName("", 2), PALETTE[2]);
	assert.equal(colourForName(undefined, 17), PALETTE[1]);
	assert.match(colourForName("", -1), /^#[0-9a-f]{6}$/);
});

test("assignColours never gives two auxes the same colour (up to 16 auxes)", () =>
{
	//the aux names from a real Quantum session, where plain hashing gave two auxes the same colour
	const names = ["Aux 1", "Anything2", "Aux 3", "Snare Long Verb", "Gtr Verb", "Vocal Verb", "Aux 7", "Aux 8",
		"Drums Verb", "Cimbal Verb", "Delay", "Raumzeit", "Aux 13", "Aux 14", "Aux 15", "Aux 16"];
	const colours = assignColours(names);
	assert.equal(colours.length, 16);
	assert.equal(new Set(colours).size, 16);
	for(let i = 0; i < 200; i++)
	{
		const some = Array.from({length: 1 + (i % 16)}, (_, n) => `Musician ${i}-${n}`);
		const assigned = assignColours(some);
		assert.equal(new Set(assigned).size, some.length);
	}
});

test("assignColours keeps a name's own colour unless another aux already has it", () =>
{
	const colours = assignColours(["Bass IEM", "Keys IEM"]);
	assert.equal(colours[0], colourForName("Bass IEM"));
	//moving the aux to another number keeps its colour
	assert.equal(assignColours(["New", "Other", "Bass IEM"]).includes(colourForName("Bass IEM")), true);
	//more auxes than colours: the palette is reused, still well defined
	assert.equal(assignColours(Array.from({length: 40}, (_, i) => "x" + i)).length, 40);
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
