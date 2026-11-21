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
	groupMembers,
	limitGroupMove,
	planGroupMove,
	MAX_STEP_UP_DB,
	STEP_FLOOR_DB
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

test("group members can be filtered (disabled channels are not trimmed)", () =>
{
	const channels = [{ group: "drums" }, { group: "drums" }, { group: "drums" }];
	assert.deepEqual(groupMembers(channels, "drums", channel => channel !== 2), [1, 3]);
});

test("limitGroupMove never limits a move down", () =>
{
	assert.equal(limitGroupMove(0, -150), -150);
	assert.equal(limitGroupMove(10, -40), -40);
});

test("limitGroupMove limits a single big jump up", () =>
{
	assert.equal(limitGroupMove(-30, 10), -30 + MAX_STEP_UP_DB);
	assert.equal(limitGroupMove(-10, 0), 0, "small moves pass");
	//from off, the inaudible bottom of the fader may be crossed in one go
	assert.equal(limitGroupMove(-150, -70), -70);
	assert.equal(limitGroupMove(-150, 10), STEP_FLOOR_DB + MAX_STEP_UP_DB);
});

test("planGroupMove rejects a move while any member level is unknown", () =>
{
	const levels = new Map([[1, -10], [2, undefined], [3, -5]]);
	assert.deepEqual(planGroupMove(0, -3, levels), {action: "reject", missing: [2]});
});

test("planGroupMove ignores non-numbers instead of treating them as off", () =>
{
	assert.deepEqual(planGroupMove(0, "loud", new Map()), {action: "ignore"});
	assert.deepEqual(planGroupMove(0, NaN, new Map()), {action: "ignore"});
	assert.deepEqual(planGroupMove(0, undefined, new Map()), {action: "ignore"});
});

test("planGroupMove applies clamped and limited moves", () =>
{
	const levels = new Map([[1, -10]]);
	assert.deepEqual(planGroupMove(0, -6, levels), {action: "apply", levelDb: -6, deltaDb: -6, limited: false});
	assert.deepEqual(planGroupMove(-40, 50, levels), {action: "apply", levelDb: -20, deltaDb: 20, limited: true});
	assert.deepEqual(planGroupMove(0, 50, levels), {action: "apply", levelDb: MAX_DB, deltaDb: 10, limited: false});
	assert.deepEqual(planGroupMove(0, 0, new Map()), {action: "apply", levelDb: 0, deltaDb: 0, limited: false});
});

test("a group pulled to off and back up step by step restores the balance and never exceeds the start", () =>
{
	//the server sends the limited level back; a client dragging up gets there in steps
	const start = [-10, -3];
	let group = 0;
	let sends = start.slice();
	let virtual = [null, null];
	const move = requested => {
		const plan = planGroupMove(group, requested, new Map(sends.map((level, i) => [i, level])));
		group = plan.levelDb;
		sends = sends.map((level, i) => {
			const result = applyTrim(level, virtual[i], plan.deltaDb);
			virtual[i] = result.virtualDb;
			return result.sendDb;
		});
	};
	move(-150);
	assert.deepEqual(sends, [MIN_DB, MIN_DB]);
	while(group < 0)
	{
		move(0);
		assert.ok(sends.every((level, i) => level <= start[i]));
	}
	assert.deepEqual(sends, start);
});
