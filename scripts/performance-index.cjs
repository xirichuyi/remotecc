const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { ChatStore } = require('../src/store.cjs');
const { createSession } = require('../src/remote.cjs');
const { RemoteHistory } = require('../src/history.cjs');
const { SessionUpdates } = require('../src/session-updates.cjs');
(async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rcc-index-bench-'));
  try {
    const result={merge:{}};
    for(const count of [200,1000,3000]) {
      const sessions=Array.from({length:count},(_,i)=>({...createSession({host:'axi'}),remoteSessionId:'remote-'+i,historyLoaded:false}));
      const history=new RemoteHistory(null,{sessions,store:{save(){}}});
      history.run=async()=>({sessions:Array.from({length:200},(_,i)=>({sessionId:'remote-'+(count-200+i),name:'title',reference:'ref',updatedAt:1})),nextOffset:null,total:count,unreadable:[]});
      const samples=[];
      for(let i=0;i<10;i++){const start=performance.now();await history.discover({host:'axi'});samples.push(performance.now()-start);}
      samples.sort((a,b)=>a-b);result.merge[count]={medianMs:+samples[5].toFixed(2),maxMs:+samples[9].toFixed(2)};
    }
    const file=path.join(directory,'chats.json');
    const sessions=Array.from({length:100},()=>({...createSession({host:'axi'}),messages:[{id:'m',role:'user',text:'x'.repeat(100000)}]}));
    new ChatStore(file).save(sessions);
    const measure=lazy=>{const start=performance.now();const items=new ChatStore(file).load({lazy});return {ms:+(performance.now()-start).toFixed(2),messageBytes:items.reduce((n,item)=>n+JSON.stringify(item.messages).length,0)};};
    result.startup={full:measure(false),metadata:measure(true)};
    const updates=new SessionUpdates(); const session=sessions[0];
    session.messages.push({id:'reply',revision:1,text:'new reply'});updates.packet(session);
    session.messages[1].revision++;session.messages[1].text+=' continued';
    result.ipc={fullBytes:Buffer.byteLength(JSON.stringify(session)),changedBytes:Buffer.byteLength(JSON.stringify(updates.packet(session)))};
    fs.writeFileSync('dist/performance-index.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
