// Runs every specs/*.js in order. Each spec exports async (t) => {...}.
// Exit code 1 if any check fails, a spec throws or a spec times out.
const fs = require("fs");
const path = require("path");
const harness = require("./harness");

const SPEC_TIMEOUT_MS = 30000;
let failures = 0;
let passes = 0;

function makeT(specName) {
  return {
    ...harness,
    ok(name, condition, detail = "") {
      if (condition) {
        passes++;
        console.log(`  ✓ ${name}`);
      } else {
        failures++;
        console.log(`  ✗ ${name}${detail ? ` (${detail})` : ""}`);
      }
    },
    noErrors(w, page) {
      this.ok(`${page}: no script errors`, w._errors.length === 0, w._errors.join("; "));
    },
    specName
  };
}

async function main() {
  const only = process.argv[2];
  const files = fs.readdirSync(path.join(__dirname, "specs"))
    .filter(f => f.endsWith(".js") && (!only || f.includes(only)))
    .sort();
  let ctx = { server: await harness.startServer({ port: 5199 }) };
  for (const file of files) {
    console.log(file);
    const spec = require(path.join(__dirname, "specs", file));
    let timer;
    try {
      await Promise.race([
        spec(makeT(file), ctx),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${SPEC_TIMEOUT_MS / 1000}s`)), SPEC_TIMEOUT_MS); })
      ]);
    } catch (error) {
      failures++;
      console.log(`  ✗ ${file} crashed: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  return failures ? 1 : 0;
}

main()
  .then(code => { harness.stopServers(); process.exit(code); })
  .catch(error => { console.error(error); harness.stopServers(); process.exit(1); });
