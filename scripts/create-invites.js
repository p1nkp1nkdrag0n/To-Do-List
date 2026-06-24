import { createDatabase } from "../server/db.js";
import { createRegistrationInvite } from "../server/registration.js";

function parseCount(argv) {
  const countFlag = argv.find((item) => item === "--count" || item.startsWith("--count="));
  if (!countFlag) {
    return 1;
  }
  const raw = countFlag.includes("=")
    ? countFlag.split("=")[1]
    : argv[argv.indexOf(countFlag) + 1];
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new Error("--count must be an integer from 1 to 100.");
  }
  return count;
}

const count = parseCount(process.argv.slice(2));
const db = await createDatabase();
const invites = [];

for (let index = 0; index < count; index += 1) {
  invites.push(await createRegistrationInvite(db));
}

console.log(`Created ${invites.length} registration invite${invites.length === 1 ? "" : "s"} in ${db.filePath || "memory"}.`);
console.log("Share each code once; only the hash is stored.");
for (const invite of invites) {
  console.log(invite.code);
}
