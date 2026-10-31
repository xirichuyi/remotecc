const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { SSHConnections } = require('../src/ssh.cjs');
const { shellQuote } = require('../src/remote.cjs');
(async () => {
  const ssh = new SSHConnections();
  const session = { host: 'axi' };
  let remote;
  try {
    await ssh.connect(session);
    const python = "import signal\nsignal.alarm(60)\nfrom http.server import HTTPServer, BaseHTTPRequestHandler\nclass Handler(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200); self.end_headers(); self.wfile.write(b'remotecc-tunnel-ok')\nserver=HTTPServer(('127.0.0.1',0),Handler)\nprint(server.server_port,flush=True)\nserver.serve_forever()";
    remote = ssh.spawn(session, 'python3 -u -c ' + shellQuote(python));
    const [chunk] = await once(remote.stdout, 'data');
    const remotePort = Number(chunk.toString().trim());
    const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const localPort = server.address().port; await new Promise(resolve => server.close(resolve));
    await ssh.forward(session, localPort, remotePort);
    assert.equal(await (await fetch(`http://127.0.0.1:${localPort}`, { signal: AbortSignal.timeout(10000) })).text(), 'remotecc-tunnel-ok');
    await ssh.forward(session, localPort, remotePort, true);
    assert.deepEqual(ssh.tunnels(session), []);
    console.log('PASS: axi SSH tunnel forwards real HTTP response and closes');
  } finally { remote?.kill(); await ssh.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
