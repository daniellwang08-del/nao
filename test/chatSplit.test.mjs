import "./chrome-stub.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { splitPerQuestion } = await import("../src/panel/ui/Chat.js");

test("an answer to several selected questions splits per question", () => {
  const parts = splitPerQuestion(
    "### Are you authorized to work in the US?\nYes\n\n### Why do you want to work here?\nI want to build tools people use.\nEvery day.\n"
  );
  assert.deepEqual(parts, [
    { question: "Are you authorized to work in the US?", answer: "Yes" },
    { question: "Why do you want to work here?", answer: "I want to build tools people use.\nEvery day." },
  ]);
});

test("a single answer (or one heading) stays one answer", () => {
  assert.equal(splitPerQuestion("Yes, I am authorized."), null);
  assert.equal(splitPerQuestion("### Only one\nYes"), null);
});
