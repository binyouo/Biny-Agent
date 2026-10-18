import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSupervisionCommand, isGoalControlCommand } from "../src/runtime/supervisionCommand.js";

test("supervision admits one literal plan query or update", () => {
  for (const command of [
    "biny plan status graph-1 --json",
    "biny plan update --input '{\"graphId\":\"graph-1\",\"action\":\"stop\"}' --json",
    "biny plan update --input '{\"reason\":\"can'\\''t proceed\"}' --session session-1 --revision 4 --json"
  ]) assert.doesNotThrow(() => assertSupervisionCommand(command), command);
});

test("supervision refuses shell expansion, composition, foreign executables and unrelated actions", () => {
  for (const command of [
    "biny plan status graph-1 && touch changed",
    "biny plan status graph-1; touch changed",
    "biny plan status $(touch changed)",
    "biny plan status `touch changed`",
    'biny plan status "$GRAPH"',
    "biny plan status graph-1 > changed",
    "biny plan status graph-1 | cat",
    "biny plan status graph-1\ntouch changed",
    "biny plan status graph-1 &",
    "./biny plan status graph-1",
    "node malicious.js plan status graph-1",
    "biny todo clear --yes",
    "biny plan start --input '{}'",
    "biny plan status graph-1 --input '{}'",
    "biny plan update",
    "biny plan status graph-1 --unknown"
  ]) assert.throws(() => assertSupervisionCommand(command), undefined, command);
  assert.throws(() => assertSupervisionCommand("biny plan status graph-1", true), /background/u);
});

test("only pure goal commands are excluded from work activity", () => {
  assert.equal(isGoalControlCommand("biny goal show --json"), true);
  assert.equal(isGoalControlCommand("biny goal update --input '{\"status\":\"completed\"}' --json"), true);
  for (const command of [
    "touch result && biny goal show --json",
    "biny goal show --json; touch result",
    "biny goal show --json > result",
    "biny goal pause --session s",
    "biny goal show --unknown",
    "biny todo show --json"
  ]) assert.equal(isGoalControlCommand(command), false, command);
});
