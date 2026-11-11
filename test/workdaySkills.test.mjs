// Workday "Type to Add Skills" (issue #38): pick the skill itself in Workday's own ranking, searching the
// official name of short forms. Runs the REAL code from wd-steps.js against the result lists in the report.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../content/workday/wd-steps.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const grab = (n) => {
  const i = src.indexOf(`  function ${n}(`);
  assert.ok(i !== -1, `missing ${n}`);
  return src.slice(i, src.indexOf("\n  }\n", i) + 4);
};
const constBlock = (n) => {
  const i = src.indexOf(`  const ${n} = {`);
  assert.ok(i !== -1, `missing ${n}`);
  return src.slice(i, src.indexOf("\n  };\n", i) + 5);
};
const D = { norm: (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase() };
const env = { D, promptResultOptions: (root) => root.map((t) => ({ textContent: t })) };
const { pick, official } = new Function(
  ...Object.keys(env),
  `${[constBlock("SKILL_OFFICIAL"), grab("officialSkillName"), grab("skillTextRelated"), grab("pickBestSkillOption")].join("\n")}
return { pick: pickBestSkillOption, official: officialSkillName };`,
)(...Object.values(env));
const choose = (token, rows) => {
  const o = pick(token, rows, official(token));
  return o && o.textContent;
};

test("Azure: Workday's top result, not the shortest look-alike (screenshot list)", () => {
  const rows = ["Microsoft Azure", "Azure Local", "Microsoft Cloud", "Cloud Server", "Azure Batch", "Azure Repos", "Azure Stack", "Cloud Computing", "SAP on Azure"];
  assert.equal(official("Azure"), "Microsoft Azure");
  assert.equal(choose("Azure", rows), "Microsoft Azure");
});

test("a language with a qualifier is the language, not a tool named after it", () => {
  assert.equal(choose("Python", ["Python IDLE", "Python (Programming Language)"]), "Python (Programming Language)");
  assert.equal(choose("Java", ["Java 3D", "Java (Programming Language)"]), "Java (Programming Language)");
});

test("the short form in parentheses is the skill", () => {
  assert.equal(choose("SQL", ["SQL for Java", "Structured Query Language (SQL)"]), "Structured Query Language (SQL)");
});

test("AWS is searched by its official name and resolves to it (screenshot list)", () => {
  assert.equal(official("AWS"), "Amazon Web Services");
  const rows = ["Amazon Web Services (AWS)", "Amazon Web Services (AWS) Security", "Avaloq Web Services", "AWS Cloud Computing", "Java Web Services"];
  assert.equal(choose("AWS", rows), "Amazon Web Services (AWS)");
});

test("exact names still win and unrelated rows are never taken", () => {
  assert.equal(choose("Git", ["GitHub", "Git", "GitLab"]), "Git");
  assert.equal(choose("Kubernetes", ["Kubernetes"]), "Kubernetes");
  assert.equal(choose("Go", ["Go-Karts", "Google Ads"]), null);
});

test("with no exact form, the first related row in Workday's order is taken", () => {
  assert.equal(choose("Terraform", ["Terraform (Software)", "Terraform Cloud"]), "Terraform (Software)");
  assert.equal(choose("Docker", ["Docker Swarm", "Docker Compose"]), "Docker Swarm");
});
