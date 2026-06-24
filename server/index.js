import { startServer } from "./startup.js";

const port = Number(process.env.PORT || 4000);
const server = await startServer({ port });
const displayHost = server.host && !["::", "0.0.0.0"].includes(server.host) ? server.host : "localhost";

console.log(`Server running at http://${displayHost}:${server.port}`);
