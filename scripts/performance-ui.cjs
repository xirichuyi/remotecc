const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
(async()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'remotecc-ui-perf-'));
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try{
    app=await electron.launch({args:[path.resolve('scripts/fixture-app.cjs'),'--user-data-dir='+folder],env});
    const page=await app.firstWindow();await page.waitForFunction(()=>!!window.remoteCC);
    const result=await page.evaluate(()=>{
      const results={};
      const measure=fn=>{const values=[];for(let i=0;i<10;i++){const t=performance.now();fn();values.push(performance.now()-t);}values.sort((a,b)=>a-b);return {samples:10,medianMs:Number(values[5].toFixed(1)),maxMs:Number(values[9].toFixed(1))};};
      for(const count of [100,1000]){
        sessions=Array.from({length:count},(_,i)=>({id:'perf-'+i,name:'Synthetic chat '+i,host:'fixture',directory:'/project/'+i%10,updatedAt:Date.now()-i,messages:[],permissions:[],status:'idle'}));
        results['sidebar'+count]=measure(()=>renderList());
      }
      const session=sessions[0];activeId=session.id;
      session.messages=Array.from({length:200},(_,i)=>({id:'msg-'+i,role:'user',text:'synthetic content '.repeat(300),createdAt:Date.now()}));
      session.messages.push({id:'answer',role:'assistant',blocks:[{type:'text',text:'reply'}]});session.status='working';
      renderMessages(session);
      results.loadedHistoryBytes=JSON.stringify(session.messages).length;
      results.updateWith200Messages=measure(()=>{session.messages.at(-1).blocks[0].text+=' next';updateUI();renderList();});
      return results;
    });
    fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/performance-ui.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  }finally{if(app)await app.close();fs.rmSync(folder,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
