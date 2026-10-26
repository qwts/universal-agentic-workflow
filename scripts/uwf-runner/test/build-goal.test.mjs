import assert from "node:assert/strict";
import { buildGoal, parseIssueRefs } from "../../uwf-on-pr/build-goal.mjs";

const repo = "qwts/toy";
const refs = parseIssueRefs("Closes #3, fixes qwts/other#7. See #3 again, self #9, url a/b/#4 and x&#5", { repo, selfNumber: 9 });
assert.deepEqual(refs, [{ repo, number: 3 }, { repo: "qwts/other", number: 7 }]);
assert.deepEqual(parseIssueRefs(null, { repo }), []);
assert.equal(parseIssueRefs(Array.from({ length: 30 }, (_, i) => `#${i + 1}`).join(" "), { repo }).length, 10);

const goal = buildGoal({ number: 9, title: "Add X", body: "Resolves #3 and #4", repo }, ({ number }) =>
  number === 3 ? { title: "Issue three", body: "do it" } : null);
assert.match(goal, /^# Goal: Add X/);
assert.match(goal, /## Linked issue qwts\/toy#3\n\n\*\*Issue three\*\*\n\ndo it/);
assert.match(goal, /## Linked issue qwts\/toy#4\n\n\(could not be fetched\)/);
assert.match(buildGoal({ number: 1, title: "T", body: "", repo }), /\(no description\)/);
console.log("build-goal tests passed");
