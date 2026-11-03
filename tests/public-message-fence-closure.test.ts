import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicAssistantStream, publicAssistantMessage } from "../src/session/publicMessage.js";

// CommonMark closing fences may have only spaces/tabs after the marker run.
// These lines are code, not closing fences, so their following XML must survive.
const cases = [
  { opening: "```xml", falseClose: "```not-a-close", close: "```" },
  { opening: "```xml", falseClose: "``` not-a-close", close: "```" },
  { opening: "~~~xml", falseClose: "~~~not-a-close", close: "~~~" },
  { opening: "````xml", falseClose: "`````more", close: "````" },
  { opening: "   ```xml", falseClose: "   ```info", close: "   ```" },
  { opening: "```xml", falseClose: "```\t \tinfo", close: "```\t " },
  { opening: "```xml", falseClose: "```\u00a0", close: "```" },
  { opening: "```xml", falseClose: "```" + " ".repeat(600) + "info", close: "```" }
];

function checkStream(raw: string, expected: string, chunks: string[]): void {
  const stream = new PublicAssistantStream();
  let input = "";
  let emitted = "";
  for (const chunk of chunks) {
    input += chunk;
    emitted += stream.push(chunk);
    assert.ok(publicAssistantMessage(input).startsWith(emitted), "Stream must remain a safe canonical prefix");
  }
  emitted += stream.finish(publicAssistantMessage(raw));
  assert.equal(emitted, expected);
  assert.equal(stream.finish(expected), "");
}

for (const [index, fixture] of cases.entries()) {
  test(`non-closing fence line preserves code and the actual closing boundary: ${index}`, () => {
    const code = `${fixture.opening}\n${fixture.falseClose}\n<think>literal XML example</think>\n${fixture.close}\n`;
    const raw = `${code}<think>internal analysis</think>Visible answer`;
    const expected = `${code}Visible answer`;
    assert.equal(publicAssistantMessage(raw), expected);
    checkStream(raw, expected, [...raw]);
    for (let split = 0; split <= raw.length; split++) checkStream(raw, expected, [raw.slice(0, split), raw.slice(split)]);
  });
}

for (const ending of ["\n", "\r\n"]) {
  test(`valid closing suffixes still end code before internal analysis: ${JSON.stringify(ending)}`, () => {
    for (const marker of ["```", "~~~"]) for (const suffix of ["", " ", "\t", " \t "]) {
      const code = `${marker}xml${ending}<think>literal</think>${ending}${marker}${suffix}${ending}`;
      const raw = `${code}<thinking>internal analysis</thinking>Answer`;
      const expected = `${code}Answer`;
      assert.equal(publicAssistantMessage(raw), expected);
      checkStream(raw, expected, [...raw]);
    }
  });
}

test("an unclosed code block keeps literal reasoning markup after a false closing line", () => {
  const raw = "```xml\n```info\n<thinking>literal example</thinking>";
  assert.equal(publicAssistantMessage(raw), raw);
  checkStream(raw, raw, [...raw]);
});

test("reset retires a pending closing-fence candidate before a new reply", () => {
  const stream = new PublicAssistantStream();
  stream.push("```xml\n``` \t\r");
  stream.reset();
  const raw = "<think>internal analysis</think>Fresh answer";
  let emitted = stream.push(raw);
  emitted += stream.finish(publicAssistantMessage(raw));
  assert.equal(emitted, "Fresh answer");
});
