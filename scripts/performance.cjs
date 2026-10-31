// Repeatable bounded benchmark: temporary remote fixtures, no Claude requests.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { SSHConnections } = require('../src/ssh.cjs');
const { RemoteFiles } = require('../src/files.cjs');
const { RemoteHistory } = require('../src/history.cjs');
const { taskBundle } = require('../src/persistent-tasks.cjs');
const { ChatStore } = require('../src/store.cjs');
const { shellQuote, createSession } = require('../src/remote.cjs');
const { once } = require('node:events');
const stats = values => {
  const sorted = [...values].sort((a,b)=>a-b);
  const middle = Math.floor(sorted.length/2);
  return { samples: values.length, min: Math.round(sorted[0]), median: Math.round(sorted.length % 2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2), max: Math.round(sorted.at(-1)), valuesMs: values.map(value => Number(value.toFixed(2))) };
};
(async () => {
  const ssh = new SSHConnections();
  const config = { host: process.env.REMOTECC_TEST_HOST || 'axi', directory: '/tmp', id: 'performance' };
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'remotecc-perf-'));
  const result = { time: new Date().toISOString(), host: config.host, milliseconds: {}, payloads: {} };
  let remote, requestCount = 0, responseBytes = 0;
  const spawn = ssh.spawn.bind(ssh);
  ssh.spawn = (...args) => {
    requestCount++;
    const child = spawn(...args);
    child.stdout.on('data', chunk => { responseBytes += Buffer.byteLength(chunk); });
    return child;
  };
  const files = new RemoteFiles(ssh);
  async function sample(name, count, operation) {
    const timings = [], initial = responseBytes, calls = requestCount;
    for (let index=0;index<count;index++) {
      const start = performance.now(); await operation(index); timings.push(performance.now()-start);
    }
    result.milliseconds[name] = stats(timings);
    result.payloads[name] = { requests: requestCount-calls, receivedBytes: responseBytes-initial };
    console.log(name, JSON.stringify(result.milliseconds[name]));
  }
  async function python(source) {
    const child = ssh.spawn(config, 'python3 -c ' + shellQuote(source)); child.stdin.end();
    let output = '', error = '';
    child.stdout.on('data', chunk => {output += chunk;}); child.stderr.on('data', chunk => {error += chunk;});
    const [code] = await once(child, 'close'); if (code) throw new Error(error); return output.trim();
  }
  try {
    await sample('newConnection', 3, async () => { await ssh.disconnect(config); await ssh.connect(config); });
    remote = await python(`import tempfile,os,zlib,struct,binascii
p=tempfile.mkdtemp(prefix='remotecc-perf-')
open(p+'/text.txt','w').write('benchmark line\\n'*69905)
open(p+'/download.bin','wb').write(os.urandom(8*1024*1024))
def chunk(t,d): return struct.pack('!I',len(d))+t+d+struct.pack('!I',binascii.crc32(t+d)&0xffffffff)
png=b'\\x89PNG\\r\\n\\x1a\\n'+chunk(b'IHDR',struct.pack('!2I5B',1024,1024,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(b'\\0'+os.urandom(3072) for _ in range(1024))))+chunk(b'IEND',b'')
open(p+'/image.png','wb').write(png)
print(p)`);
    config.directory = remote;
    await sample('directory', 5, () => files.list(config, remote));
    await sample('historyMetadata', 3, () => new RemoteHistory(ssh, {}).run(config, { operation: 'list', offset: 0 }));
    await sample('textPreview1MiB', 3, () => files.preview(config, remote+'/text.txt'));
    await sample('pngPreview3MiB', 3, () => files.preview(config, remote+'/image.png'));
    await sample('pngPreviewWarm', 3, () => files.preview(config, remote+'/image.png'));
    await sample('download8MiB', 2, i => files.download(config, remote+'/download.bin', path.join(folder,'download-'+i)));
    await sample('download8MiBWarm', 3, i => files.download(config, remote+'/download.bin', path.join(folder,'warm-'+i)));
    await sample('upload1MiB', 2, i => { const file=path.join(folder,'upload-'+i); fs.writeFileSync(file,randomBytes(1024*1024)); return files.upload(config,file,remote); });
    await sample('taskBundleLocal', 5, () => taskBundle());
    const store = new ChatStore(path.join(folder,'chats.json'));
    const sessions = Array.from({length:100}, () => ({ ...createSession(config), messages: [{id:'m',role:'user',text:'x'.repeat(100000)}] }));
    await sample('store10MBFullRewrite', 20, () => store.save(sessions));
    await sample('store10MBOneSessionUpdate', 20, i => { sessions[0].name = 'change-' + i; store.save(sessions, sessions[0]); });
    await sample('store10MBLoad', 5, () => store.load());
    let total = 0, last = 0;
    for(let version=1;version<=100;version++) {
      last=Buffer.byteLength(JSON.stringify({version,status:'working',message:{id:'m',blocks:[{type:'text',text:'x'.repeat(version*512)}]}})); total+=last;
    }
    result.syntheticSnapshots = { updates:100, finalBytes:last, totalBytes:total, amplification:Number((total/last).toFixed(1)), note:'Synthetic growing reply; not measured Claude traffic' };
    fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/performance.json',JSON.stringify(result,null,2));
    console.log(JSON.stringify(result,null,2));
  } finally {
    if (remote) await python('import shutil; shutil.rmtree('+JSON.stringify(remote)+')').catch(()=>{});
    await ssh.close(); fs.rmSync(folder,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
