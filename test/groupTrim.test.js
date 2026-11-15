"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
	MIN_DB,
	MAX_DB,
	clampDb,
	applyTrim,
	isValidGroupId,
	parseGroupAddress,
	groupAddress,
	groupMembers
} = require("../lib/groupTrim.js");

/**
 * Run a sequence of group fader moves over some member sends, the way index.js does.
 */
function simulate(members, groupMoves)
{
	let sends = members.slice();
	let virtual = members.map(() => null);
	let group = 0;
	for(const next of groupMoves)
	{
		const delta = clampDb(next) - group;
		group = clampDb(next);
		for(let i = 0; i < sends.length; i++)
		{
			const result = applyTrim(sends[i], virtual[i], delta);
			sends[i] = result.sendDb;
			virtual[i] = result.virtualDb;
		}
	}
	return { sends, virtual };
}

test("clampDb keeps values inside the desk range", () =>
{
	assert.equal(clampDb(-5), -5);
	assert.equal(clampDb(-200), MIN_DB);
	assert.equal(clampDb(20), MAX_DB);
	assert.equal(clampDb("x"), MIN_DB);
	assert.equal(clampDb(NaN), MIN_DB);
});

test("a trim inside the range moves the send by delta and remembers nothing", () =>
{
	assert.deepEqual(applyTrim(-10, null, -6), { sendDb: -16, virtualDb: null });
	assert.deepEqual(applyTrim(-10, undefined, 4), { sendDb: -6, virtualDb: null });
});

test("a trim past the ceiling clamps and remembers the overshoot", () =>
{
	assert.deepEqual(applyTrim(5, null, 10), { sendDb: MAX_DB, virtualDb: 15 });
	assert.deepEqual(applyTrim(MAX_DB, 15, -10), { sendDb: 5, virtualDb: null });
});

test("pulling a group to off and back restores the original balance", () =>
{
	const original = [-3, -12, -30, -60];
	const down = simulate(original, [-150]);
	assert.deepEqual(down.sends, [MIN_DB, MIN_DB, MIN_DB, MIN_DB]);

	const back = simulate(original, [-150, 0]);
	assert.deepEqual(back.sends, original);
	assert.deepEqual(back.virtual, [null, null, null, null]);
});

test("pushing a group up into the ceiling and back restores the balance", () =>
{
	const original = [0, -6, -20];
	const result = simulate(original, [10, 5, 0]);
	assert.deepEqual(result.sends, original);
});

test("a send that was already off stays far below audible when the group comes up a little", () =>
{
	const result = simulate([MIN_DB], [6]);
	assert.equal(result.sends[0], MIN_DB + 6);
});

test("group ids are url safe", () =>
{
	assert.equal(isValidGroupId("drums"), true);
	assert.equal(isValidGroupId("a1b2-c3_d4"), true);
	assert.equal(isValidGroupId(""), false);
	assert.equal(isValidGroupId("has/slash"), false);
	assert.equal(isValidGroupId(undefined), false);
});

test("group addresses round trip", () =>
{
	assert.equal(groupAddress(3, "drums"), "/Webmixer/Aux/3/Group/drums/level");
	assert.deepEqual(parseGroupAddress("/Webmixer/Aux/3/Group/drums/level"), { aux: 3, groupId: "drums", query: false });
	assert.deepEqual(parseGroupAddress("/Webmixer/Aux/3/Group/drums/level/?"), { aux: 3, groupId: "drums", query: true });
	assert.equal(parseGroupAddress("/Webmixer/Aux/3/Group/drums"), null);
	assert.equal(parseGroupAddress("/Input_Channels/1/Aux_Send/3/send_level"), null);
	assert.equal(parseGroupAddress(undefined), null);
});

test("group members are the channels assigned to the group", () =>
{
	const channels = [{ group: "drums" }, { group: "" }, undefined, { group: "drums" }, { group: "vox" }];
	assert.deepEqual(groupMembers(channels, "drums"), [1, 4]);
	assert.deepEqual(groupMembers(channels, "vox"), [5]);
	assert.deepEqual(groupMembers(channels, "none"), []);
	assert.deepEqual(groupMembers(undefined, "drums"), []);
});
