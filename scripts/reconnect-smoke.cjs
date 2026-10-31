// Only terminates the SSH master owned by this test, never another SSH session.
const { SSHConnections } = require('../src/ssh.cjs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const assert = require('node:assert/strict');
const run = promisify(execFile);
(async () => {
  const connections = new SSHConnections(), config = {host:'axi',directory:'/tmp'};
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await connections.connect(config);
    const entry = [...connections.connections.values()][0];
    const recovered = once(connections, 'recovered', {signal:AbortSignal.timeout(45000)});
    await run('/usr/bin/ssh',['-S',entry.socket,'-O','exit',config.host]);
    await connections.checkMaster(entry);
    assert.equal(connections.state(config).status,'reconnecting');
    await recovered;
    assert.equal(connections.state(config).status,'connected');
    const child = connections.spawn(config,'printf recovered'); child.stdin.end();
    let output=''; child.stdout.on('data',chunk=>output+=chunk);
    const [code] = await once(child,'close'); assert.equal(code,0); assert.equal(output,'recovered');
    await connections.disconnect(config);
    connections.scheduleReconnect(config);
    assert.equal(connections.retries.size,0);
    assert.equal(connections.state(config).status,'disconnected');
    console.log('PASS axi: owned SSH master loss → automatic recovery → command succeeds; manual disconnect cancels retry');
  } finally {clearInterval(keepAlive); await connections.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
