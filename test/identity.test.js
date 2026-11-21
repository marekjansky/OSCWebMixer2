"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
	nameStatus,
	isChanged,
	effectiveAuxColour,
	lockState,
	identityChanges,
	confirmSlot
} = require("../lib/identity.js");
const { colourForName } = require("../lib/colour.js");

test("nameStatus", () =>
{
	assert.equal(nameStatus(undefined, undefined), "unknown");
	assert.equal(nameStatus("Bob", undefined), "unknown");
	assert.equal(nameStatus(undefined, "Bob"), "first");
	assert.equal(nameStatus("", "Bob"), "first");
	assert.equal(nameStatus("Bob", "Bob"), "same");
	assert.equal(nameStatus("bob ", "BOB"), "same", "spelling/case changes are the same musician");
	assert.equal(nameStatus("Bob", "Alice"), "changed");
	assert.equal(nameStatus("Bob", ""), "changed", "a cleared name is a change");
	assert.ok(isChanged("Bob", "Alice"));
	assert.ok(!isChanged(undefined, "Alice"));
});

test("unset colour follows the desk name", () =>
{
	assert.equal(effectiveAuxColour(undefined, "Alice", "#111111"), "#111111");
	assert.equal(effectiveAuxColour({colour: ""}, "Alice", "#111111"), "#111111");
});

test("a colour that was the old name's automatic colour follows the new name", () =>
{
	const slot = {colour: colourForName("Bob").toUpperCase(), name: "Bob"};
	assert.equal(effectiveAuxColour(slot, "Alice", "#111111"), "#111111");
	assert.equal(effectiveAuxColour(slot, "Bob", "#111111"), slot.colour, "unchanged name keeps it");
});

test("a custom colour stays on a renamed slot until confirmed", () =>
{
	const slot = {colour: "#123456", name: "Bob"};
	assert.equal(effectiveAuxColour(slot, "Alice", "#111111"), "#123456");
});

test("lockState", () =>
{
	assert.deepEqual(lockState({aux: 1, auxName: "Bob"}, "Bob"), {suspended: false, auxName: "Bob"});
	assert.deepEqual(lockState({aux: 1, auxName: "Bob"}, "Alice"), {suspended: true, auxName: "Alice"});
	assert.deepEqual(lockState({aux: 1}, "Alice"), {suspended: false, auxName: "Alice"}, "legacy lock without a name");
	assert.deepEqual(lockState({aux: 9, auxName: "Bob"}, undefined), {suspended: true, auxName: ""}, "aux gone from the desk");
});

test("identityChanges lists changed auxes and channels, and auxes with mismatched locks", () =>
{
	const auxNames = ["Bob", "Carol", "Dave"];
	const channelNames = ["Kick", "Snare"];
	const changes = identityChanges({
		auxCount: 3,
		channelCount: 2,
		auxName: aux => auxNames[aux - 1],
		channelName: channel => channelNames[channel - 1],
		state: {
			auxes: [{name: "Bob"}, {name: "Eve"}, {name: "Dave"}],
			channels: [{name: "Kick"}, {name: "Tom"}]
		},
		locks: {
			dev1: {aux: 3, auxName: "Frank"}, //state says Dave (e.g. preset loaded) but lock was made for Frank
			dev2: {aux: 1, auxName: "Bob"}
		}
	});
	assert.deepEqual(changes, [
		{type: "aux", number: 2, previousName: "Eve", currentName: "Carol", movedFrom: null},
		{type: "aux", number: 3, previousName: "Frank", currentName: "Dave", movedFrom: null},
		{type: "channel", number: 2, previousName: "Tom", currentName: "Snare", movedFrom: null}
	]);
});

test("identityChanges ignores slots seen for the first time", () =>
{
	const changes = identityChanges({
		auxCount: 1, channelCount: 1,
		auxName: () => "Bob", channelName: () => "Kick",
		state: {auxes: [], channels: [{enabled: true}]}
	});
	assert.deepEqual(changes, []);
});

test("confirmSlot keeping settings", () =>
{
	const slot = {enabled: false, colour: "#123456", icon: "guitar", name: "Bob"};
	assert.deepEqual(confirmSlot("aux", slot, "Alice", true, 0, 4), {enabled: false, colour: "#123456", icon: "guitar", name: "Alice"});

	const auto = {enabled: true, colour: colourForName("Bob"), icon: "", name: "Bob"};
	assert.equal(confirmSlot("aux", auto, "Alice", true, 0, 4).colour, "", "automatic colour keeps following the name");

	const channel = {enabled: true, displayOrder: 4, title: "Drums", icon: "kick", group: "drums", name: "Kick"};
	assert.deepEqual(confirmSlot("channel", channel, "Bass", true, 0, 4), {...channel, name: "Bass"});
});

test("confirmSlot resetting settings", () =>
{
	const slot = {enabled: false, colour: "#123456", icon: "guitar", name: "Bob"};
	assert.deepEqual(confirmSlot("aux", slot, "Alice", false, 0, 4), {enabled: false, colour: "", icon: "", name: "Alice"});

	const channel = {enabled: true, displayOrder: 4, title: "Drums", icon: "kick", group: "drums", name: "Kick"};
	assert.deepEqual(confirmSlot("channel", channel, "Bass", false, 0, 4), {enabled: true, title: "", icon: "", group: "", name: "Bass", displayOrder: 4});

	assert.deepEqual(confirmSlot("aux", undefined, "New", false, 0, 4), {enabled: true, colour: "", icon: "", name: "New"});
});

// ---- following moved auxes/channels (based on a real Quantum restructure: two stereo auxes
// inserted at 1 and 3, everything else shifted down)
const identityMoves = require("../lib/identity.js");
const before = ["Bass IEM", "Snare Long Verb", "Gtr Verb", "Vocal Verb", "Aux 5", "Aux 6"];
const after = ["Aux 1", "Bass IEM", "Aux 3", "Snare Long Verb", "Gtr Verb", "Vocal Verb"];
const deskAfter = n => after[n - 1];

test("findMoves: names that moved to a new number are found", () =>
{
	const slots = before.map(name => ({enabled: true, name}));
	assert.deepEqual(identityMoves.findMoves({count: 6, deskName: deskAfter, slots}), [
		{from: 1, to: 2, name: "Bass IEM"},
		{from: 2, to: 4, name: "Snare Long Verb"},
		{from: 3, to: 5, name: "Gtr Verb"},
		{from: 4, to: 6, name: "Vocal Verb"}
	]);
});

test("findMoves: ambiguous or empty names are not moved", () =>
{
	const slots = [{name: "Vox"}, {name: "Vox"}, {name: ""}];
	assert.deepEqual(identityMoves.findMoves({count: 3, deskName: n => ["Keys", "Gtr", "Vox"][n - 1], slots}), []);
	//"Vox" exists twice on the desk, so only the unique "Keys" counts as moved
	assert.deepEqual(identityMoves.findMoves({count: 3, deskName: n => ["Vox", "Keys", "Vox"][n - 1], slots: [{name: "Keys"}, {name: "Vox"}, {name: "Gtr"}]}), [{from: 1, to: 2, name: "Keys"}]);
	//case and spacing don't matter
	assert.deepEqual(identityMoves.findMoves({count: 2, deskName: n => ["new", " bass iem "][n - 1], slots: [{name: "Bass IEM"}, {name: "x"}]}), [{from: 1, to: 2, name: " bass iem "}]);
});

test("identityChanges reports movedFrom", () =>
{
	const changes = identityChanges({
		auxCount: 6, channelCount: 0, auxName: deskAfter, channelName: () => undefined,
		state: {auxes: before.map(name => ({enabled: true, name}))}
	});
	assert.deepEqual(changes.map(c => [c.number, c.movedFrom]), [[1, null], [2, 1], [3, null], [4, 2], [5, 3], [6, 4]]);
});

test("applyMovesToSlots carries settings to the new numbers; vacated slots start fresh", () =>
{
	const slots = before.map((name, i) => ({enabled: i !== 3, colour: "#00000" + i, icon: "icon" + i, name}));
	const moves = identityMoves.findMoves({count: 6, deskName: deskAfter, slots});
	const next = identityMoves.applyMovesToSlots("aux", slots, moves, deskAfter);
	assert.deepEqual(next[1], {enabled: true, colour: "#000000", icon: "icon0", name: "Bass IEM"});
	assert.deepEqual(next[3], {enabled: true, colour: "#000001", icon: "icon1", name: "Snare Long Verb"});
	assert.deepEqual(next[5], {enabled: false, colour: "#000003", icon: "icon3", name: "Vocal Verb"});
	//1 and 3 were vacated (their occupants moved) and nothing moved in: new auxes
	assert.deepEqual(next[0], {enabled: true, colour: "", icon: "", name: "Aux 1"});
	assert.deepEqual(next[2], {enabled: true, colour: "", icon: "", name: "Aux 3"});
	assert.equal(slots[1].name, "Snare Long Verb", "input not modified");
	//everything is confirmed afterwards
	assert.deepEqual(identityChanges({auxCount: 6, channelCount: 0, auxName: deskAfter, channelName: () => undefined, state: {auxes: next}}), []);
});

test("channel moves keep their settings and admin order", () =>
{
	const slots = [{enabled: true, group: "drums", title: "Drums", displayOrder: 0, name: "Kick"}, {enabled: true, group: "", displayOrder: 1, name: "Bass"}];
	const desk = n => ["Click", "Kick", "Bass"][n - 1];
	const moves = identityMoves.findMoves({count: 3, deskName: desk, slots});
	assert.deepEqual(moves.map(m => [m.from, m.to]), [[1, 2], [2, 3]]);
	const next = identityMoves.applyMovesToSlots("channel", slots, moves, desk);
	assert.equal(next[1].group, "drums");
	assert.equal(next[1].displayOrder, 0);
	assert.equal(next[2].name, "Bass");
	assert.deepEqual(next[0], {enabled: true, title: "", icon: "", group: "", displayOrder: 0, name: "Click"});
});

test("layouts and locks follow moved auxes", () =>
{
	const moves = [{from: 1, to: 2, name: "Bass IEM"}, {from: 2, to: 4, name: "Snare Long Verb"}];
	const layouts = {1: {order: [3, 1], hidden: []}, 2: {order: [5], hidden: [6]}, 9: {order: [1], hidden: []}};
	assert.deepEqual(identityMoves.moveAuxLayouts(layouts, moves), {2: layouts[1], 4: layouts[2], 9: layouts[9]});

	const locks = {
		a: {aux: 1, auxName: "Bass IEM", ip: "x"},
		b: {aux: 2, auxName: "Something else"}, //this musician's mix was renamed earlier, not confirmed
		c: {aux: 9, auxName: "Keys"}
	};
	const result = identityMoves.moveLocks(locks, moves);
	assert.deepEqual(result.locks.a, {aux: 2, auxName: "Bass IEM", ip: "x"});
	assert.deepEqual(result.locks.b, locks.b);
	assert.deepEqual(result.locks.c, locks.c);
	assert.deepEqual(result.moved, ["a"]);
});

test("channel numbers inside layouts follow moved channels", () =>
{
	const moves = [{from: 1, to: 2}, {from: 2, to: 3}];
	const layouts = {4: {order: [2, 1, 5], hidden: [1]}};
	assert.deepEqual(identityMoves.moveChannelsInLayouts(layouts, moves), {4: {order: [3, 2, 5], hidden: [2]}});
});
