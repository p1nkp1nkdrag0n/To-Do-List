import os from "node:os";

process.env.NODE_ENV ||= "lan";
process.env.HOST ||= "0.0.0.0";
process.env.PORT ||= "4000";
process.env.DB_PATH ||= "./data/app.sqlite";

function lanUrls(port) {
  const urls = new Set();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        urls.add(`http://${entry.address}:${port}/`);
      }
    }
  }
  return [...urls].sort();
}

const { startServer } = await import("../server/startup.js");

const server = await startServer({
  port: Number(process.env.PORT || 4000),
  host: process.env.HOST || "0.0.0.0"
});

console.log(`LAN server running at http://localhost:${server.port}/`);

const urls = lanUrls(server.port);
if (urls.length) {
  console.log("Open from other devices on the same LAN:");
  for (const url of urls) {
    console.log(`- ${url}`);
  }
} else {
  console.log("No LAN IPv4 address was detected. Check your network adapter or firewall.");
}

if (!process.env.AUTH_SECRET) {
  console.warn("AUTH_SECRET is not set. Set it in .env.lan so login tokens stay signed with a private secret.");
}
