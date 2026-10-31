const {test}=require('node:test');
const assert=require('node:assert/strict');
const {SessionInput}=require('../src/session-input.cjs');
test('resident stream waits between turns, preserves request identity and closes explicitly',async()=>{
 const input=new SessionInput();const waiting=input.next();
 input.push('first','one','session');assert.equal((await waiting).value.uuid,'one');
 input.push('second','two','session');assert.equal((await input.next()).value.message.content,'second');
 const next=input.next();input.close();assert.deepEqual(await next,{done:true});
 assert.throws(()=>input.push('late','three','session'));
});
