// Real remote integration: only writes in a uniquely named disposable fixture.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { SSHConnections } = require('../src/ssh.cjs');
const { ChatService } = require('../src/chat-service.cjs');
const { PersistentTasks } = require('../src/persistent-tasks.cjs');
const { RemoteFiles } = require('../src/files.cjs');
const { shellQuote } = require('../src/remote.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const config = { host: process.env.REMOTECC_TEST_HOST || 'axi', directory: '/tmp/remotecc-native-flows-' + randomUUID() };
  const ssh = new SSHConnections(), files = new RemoteFiles(ssh);
  const service = new ChatService({ load: () => [], save() {} });
  service.persistent = new PersistentTasks(ssh, service);
  let session;
  const python = async code => {
    const child = ssh.spawn(config, 'python3 -c ' + shellQuote(code)); child.stdin.end();
    let out = '', error = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => error += b);
    await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', n => n ? reject(new Error(error)) : resolve()); });
    return out.trim();
  };
  async function until(check, label, approvals = false) {
    const deadline = Date.now() + 150000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error('Timed out: ' + label + '; status=' + session.status + '; error=' + (session.messages.at(-1)?.error || session.transportError || ''));
      if (approvals) for (const p of [...session.permissions]) {
        const path = p.input?.file_path;
        const allow = ['Read', 'Edit', 'Write'].includes(p.name) && path === config.directory + '/note.txt'
          || p.name === 'Bash' && p.input.command?.trim() === 'sleep 120';
        console.log('Permission', p.name, allow ? 'allow fixture operation' : 'deny');
        await service.respond(session.id, p.id, { allow });
      }
      await pause(200);
    }
  }
  async function turn(prompt) {
    service.send(session.id, prompt);
    await until(() => !session.remoteTask, 'turn', true);
    if (session.status === 'error' && /hit your .*limit|rate.limit|quota/i.test(session.messages.at(-1)?.error || '')) {
      const context = await service.persistent.control(session, 'context');
      assert.ok(Number.isFinite(context.totalTokens) && context.maxTokens > 0, 'invalid live context');
      console.log('PASS real context control after quota failure:', context.totalTokens, '/', context.maxTokens);
      const owner = session.remoteOwner.id;
      await ssh.disconnect(config); await ssh.connect(config);
      await service.persistent.restore(config);
      await until(() => session.remoteOwner?.id === owner && !session.transportError, 'restore after quota');
      assert.ok(session.messages.at(-1).error.includes('limit'));
      console.log('PASS resident restore after real quota error; no automatic model retry');
      throw new Error('BLOCKED by remote account quota: ' + session.messages.at(-1).error);
    }
    assert.equal(session.status, 'idle', session.messages.at(-1)?.error);
  }
  try {
    await ssh.connect(config);
    await python('import os,subprocess\np=' + JSON.stringify(config.directory) + '\nos.mkdir(p)\nopen(p+"/note.txt","w").write("before\\n")\nsubprocess.run(["git","init",p],check=True,capture_output=True)\nsubprocess.run(["git","-C",p,"add","note.txt"],check=True)\nsubprocess.run(["git","-C",p,"-c","user.name=RemoteCC Test","-c","user.email=test@example.invalid","commit","-m","fixture"],check=True,capture_output=True)');
    session = service.create(config); service.configure(session.id, { selectedModel: 'sonnet', effort: 'low' });
    await turn('Use Read then Edit to change the entire contents of ' + config.directory + '/note.txt from before\\n to after\\n (one line, ending with a newline). Do not use Bash or any other tools. Reply done.');
    assert.equal(await python('print(open(' + JSON.stringify(config.directory + '/note.txt') + ').read().strip())'), 'after');
    const checkpoint = session.messages.at(-1).checkpointId;
    assert.ok(checkpoint, 'real echoed user UUID checkpoint missing');
    console.log('PASS real Read/Edit approval and checkpoint UUID');
    const context = await service.persistent.control(session, 'context');
    assert.ok(context && Object.keys(context).length, 'context empty');
    console.log('PASS resident context retrieval; keys:', Object.keys(context).join(','));
    const preview = await service.persistent.control(session, 'rewind', { checkpoint, preview: true });
    assert.equal(preview.canRewind, true, preview.error);
    assert.ok(preview.filesChanged?.some(p => p.endsWith('/note.txt')), JSON.stringify(preview));
    const result = await service.persistent.control(session, 'rewind', { checkpoint, token: preview.token });
    assert.equal(result.canRewind, true, result.error);
    assert.equal(await python('print(open(' + JSON.stringify(config.directory + '/note.txt') + ').read().strip())'), 'before');
    console.log('PASS real dry-run and file rewind, contents verified');
    const worktree = await files.run(session, { operation: 'createWorktree', branch: 'remotecc/test-' + randomUUID().slice(0, 8) });
    assert.equal(await python('print(open(' + JSON.stringify(worktree.path + '/note.txt') + ').read().strip())'), 'before');
    console.log('PASS remote Git worktree creation');
    await turn('Start exactly the Bash command sleep 120 with run_in_background=true. Do not use other commands, do not wait for completion, and reply started.');
    await until(() => session.tasks?.some(t => t.status === 'running'), 'background membership');
    const task = session.tasks.find(t => t.status === 'running');
    await service.persistent.control(session, 'stopTask', task.id);
    await until(() => !session.tasks.some(t => t.id === task.id && t.status === 'running'), 'background stopped');
    console.log('PASS real background task membership and stopTask');
    await turn('Reply RECOVERY-OK only. Do not use tools.');
    assert.ok(session.messages.at(-1).blocks.some(b => b.text?.includes('RECOVERY-OK')));
    console.log('PASS next turn after rewind and background stop');
  } finally {
    if (session?.remoteTask) { await service.stop(session.id).catch(() => {}); await until(() => !session.remoteTask, 'cleanup stop').catch(() => {}); }
    if (session?.remoteOwner) await service.persistent.release(session).catch(e => console.error('release:', e.message));
    await service.close(); await ssh.close();
    // Keep the isolated directory for inspection; never touch the user's project.
    console.log('Fixture directory:', config.directory);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
