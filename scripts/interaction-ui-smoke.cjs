const {_electron:electron}=require('playwright');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'remotecc-forms-'));
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app=await electron.launch({args:[path.resolve('scripts/fixture-app.cjs'),'--user-data-dir='+profile],env});
    const page=await app.firstWindow();const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.waitForFunction(()=>typeof activeSession==='function');
    await page.locator('#connect-server').click();
    await page.waitForFunction(()=>workspaceState==='connected'&&activeSession());
    await page.locator('#prompt').fill('elicitation-test');await page.locator('#prompt').press('Enter');
    const card=page.locator('.structured-request');await card.waitFor();
    await card.locator('[name=name]').fill('RemoteCC');
    await card.locator('[name=count]').fill('2');
    await card.locator('[name=enabled]').selectOption('false');
    await card.locator('[name=tags]').selectOption(['a','b']);
    await card.locator('button[type=submit]').click();
    await page.waitForFunction(()=>document.querySelector('.structured-request p')?.textContent==='URL test');
    assert.equal(await card.getByRole('button',{name:'打开 example.com'}).count(),1);
    await card.getByRole('button',{name:'拒绝',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.structured-request p')?.textContent==='Unsupported test');
    assert.equal(await card.locator('button[type=submit]').isDisabled(),true);
    await card.getByRole('button',{name:'取消',exact:true}).click();
    await page.waitForFunction(()=>activeSession()?.status==='idle');
    const result=JSON.parse(await page.evaluate(()=>activeSession().messages.at(-1).blocks.find(block=>block.type==='text').text));
    assert.deepEqual(result,[{action:'accept',content:{name:'RemoteCC',count:2,enabled:false,tags:['a','b']}},{action:'decline'},{action:'cancel'}]);
    assert.deepEqual(errors,[]);
    console.log('PASS Electron: shared schema controls, typed form submission through IPC/SDK, URL decline, unsupported schema cancel');
  }finally{if(app)await app.close();fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
