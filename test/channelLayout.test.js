"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { parseLayoutAddress, layoutAddress, sanitizeLayout } = require("../lib/channelLayout");
const { isAddressAllowedForAux } = require("../lib/deviceLocks");

test("layout addresses round trip", () => {
	assert.strictEqual(parseLayoutAddress(layoutAddress(7)), 7);
	assert.strictEqual(parseLayoutAddress("/Webmixer/Aux/0/Layout"), null);
	assert.strictEqual(parseLayoutAddress("/Webmixer/Aux/7/Layout/?"), null);
	assert.strictEqual(parseLayoutAddress("/Webmixer/Aux/x/Layout"), null);
});

test("layouts are cleaned up", () => {
	assert.deepStrictEqual(
		sanitizeLayout('{"order":["2",1,2,"x",0,1000,3.5],"hidden":[1,1,"4"]}'),
		{ order: [2, 1], hidden: [1, 4] }
	);
	assert.deepStrictEqual(sanitizeLayout({ order: [3], hidden: "nope" }), { order: [3], hidden: [] });
});

test("an empty or broken layout means the admin layout", () => {
	assert.strictEqual(sanitizeLayout(undefined), null);
	assert.strictEqual(sanitizeLayout("not json"), null);
	assert.strictEqual(sanitizeLayout("[1,2]"), null);
	assert.strictEqual(sanitizeLayout({ order: [], hidden: [] }), null);
});

test("a locked device can only arrange its own aux", () => {
	assert.strictEqual(isAddressAllowedForAux("/Webmixer/Aux/3/Layout", 3), true);
	assert.strictEqual(isAddressAllowedForAux("/Webmixer/Aux/4/Layout", 3), false);
});
