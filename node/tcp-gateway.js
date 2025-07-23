import net from 'net';

export function createTCPGateway(port, rns) {
  net.createServer((socket) => {
    let dest = null;

    socket.on('data', (data) => {
      if (!dest) {
        dest = data.slice(0, 20).toString('hex');
        console.log('[TCP] Set destination to', dest);
      } else {
        rns.sendData(dest, data);
      }
    });

    rns.onReceive = (rid, payload) => {
      socket.write(payload);
    };
  }).listen(port, () => {
    console.log(`[TCP Gateway] Listening on port ${port}`);
  });
}