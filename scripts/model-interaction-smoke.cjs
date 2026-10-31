const {_electron:electron}=require('playwright');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'rcc-model-interaction-'));const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
const executablePath=process.env.REMOTECC_EXECUTABLE;
app=await electron.launch({...(executablePath?{executablePath}:{}),args:[...(executablePath?[]:[path.resolve('.')]),'--user-data-dir='+profile],env});
const page=await app.firstWindow();const errors=[];page.on('pageerror',error=>errors.push(error.message));
await page.waitForFunction(()=>typeof activeSession==='function');
await page.evaluate(async()=>{const config={host:'axi',directory:'/tmp'};await api.connect(config);const s=await api.create(config);if(!sessions.some(item=>item.id===s.id))sessions.unshift(s);selectSession(s.id);});
await page.waitForFunction(()=>workspaceState==='connected'&&activeSession()?.capabilities?.models?.length>0,null,{timeout:60000});
// Submit the command exactly as a user would, then cancel without altering state.
await page.locator('#prompt').fill('/model');await page.locator('#prompt').press('Enter');
await page.locator('#command-interaction-form select').waitFor();
const offered=await page.locator('#command-interaction-form option').evaluateAll(options=>options.map(option=>option.value).filter(Boolean));
assert.deepEqual(offered,await page.evaluate(()=>activeSession().capabilities.models.map(model=>model.value)));
await page.keyboard.press('Escape');
assert.equal(await page.evaluate(()=>activeSession().preferences?.selectedModel||''),'');
assert.equal(await page.evaluate(()=>activeSession().messages.length),0);
// Click a partial completion: this must open the model picker immediately.
await page.locator('#prompt').fill('/mod');
await page.locator('.command-item').filter({has:page.locator('strong',{hasText:/^\/model$/})}).click();
await page.locator('#command-interaction-form select').selectOption('sonnet');
await page.locator('#command-interaction-form button[type=submit]').click();
await page.waitForFunction(()=>!document.querySelector('#control-dialog').open&&activeSession()?.preferences?.selectedModel==='sonnet',null,{timeout:60000});
assert.equal(await page.locator('#prompt').inputValue(),'');
await page.locator('#prompt').fill('/model default');await page.locator('#prompt').press('Enter');
await page.waitForFunction(()=>activeSession()?.preferences?.selectedModel===''&&document.querySelector('#prompt').value==='',null,{timeout:60000});
await page.locator('#prompt').fill('/model sonnet');await page.locator('#prompt').press('Enter');
await page.waitForFunction(()=>activeSession()?.preferences?.selectedModel==='sonnet'&&document.querySelector('#prompt').value==='',null,{timeout:60000});
// A second native command has its own argument interaction and applies through Claude.
await page.locator('#prompt').fill('/effort');await page.locator('#prompt').press('Enter');
await page.locator('#command-interaction-form select').selectOption('low');
await page.locator('#command-interaction-form button[type=submit]').click();
await page.waitForFunction(()=>!document.querySelector('#control-dialog').open&&activeSession()?.preferences?.effort==='low',null,{timeout:60000});
// Check the selected model actually executes the next turn.
await page.locator('#prompt').fill('Reply with MODEL-INTERACTION-OK only. Do not use tools.');await page.locator('#prompt').press('Enter');
await page.waitForFunction(()=>activeSession()?.messages.length===2&&['idle','error'].includes(activeSession().status),null,{timeout:90000});
const session=await page.evaluate(()=>activeSession());assert.equal(session.status,'idle',session.messages.at(-1).error);assert.match(session.model,/sonnet/i);
assert.ok(session.messages.at(-1).blocks.some(block=>block.text?.includes('MODEL-INTERACTION-OK')));
assert.deepEqual(errors,[]);
await page.screenshot({path:'dist/model-interaction-axi.png'});
console.log('PASS axi: /model Enter/click → remote model picker; Escape preserves settings; native model/effort controls; next real reply uses Sonnet');
}finally{if(app)await app.close();fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
