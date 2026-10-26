import fs from "node:fs";
import { dependencyNotices } from "./legal-assets.mjs";

const notices = dependencyNotices(process.cwd());
fs.mkdirSync("licenses", { recursive: true });
fs.writeFileSync("licenses/npm-notices.txt", notices.text);
console.log(`Preserved full notices for ${notices.packages.length} installed non-dev packages.`);
