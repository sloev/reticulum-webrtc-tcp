import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 8888 });
const clients = new Map();

wss.on('connection', (ws) => {
  const id = crypto.randomUUID();
  clients.set(id, ws);

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const to = msg.to;
    if (clients.has(to)) {
      clients.get(to).send(JSON.stringify({ ...msg, from: id }));
    }
  });

  ws.send(JSON.stringify({ type: 'welcome', id }));

  ws.on('close', () => {
    clients.delete(id);
  });
});

console.log('[Signaling] Server running on ws://localhost:8888');