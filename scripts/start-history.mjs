import { runServer } from '../server.mjs';
// Serve the updated UI while keeping the existing terminal owner and its PTYs alive.
await runServer({ terminalMode: true, demo: false, terminalUpstream: process.env.TERMINAL_UPSTREAM || 'http://127.0.0.1:8789', port: Number(process.env.PORT || 8790) });
