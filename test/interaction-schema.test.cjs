const {test}=require('node:test');
const assert=require('node:assert/strict');
const schemaAPI=require('../src/interaction-schema.js');
const {ChatService}=require('../src/chat-service.cjs');
const schema={type:'object',properties:{name:{type:'string',minLength:2},count:{type:'integer',minimum:1,maximum:4},enabled:{type:'boolean'},color:{type:'string',oneOf:[{const:'r',title:'Red'}]},tags:{type:'array',items:{enum:['a','b']},minItems:1,maxItems:2}},required:['name','count','enabled','color','tags']};
const content={name:'ok',count:2,enabled:false,color:'r',tags:['a','b']};
test('shared forms preserve primitive types and enforce remote constraints',()=>{
 assert.deepEqual({...schemaAPI.validate(schema,content)},content);
 for(const patch of [{count:'2'},{count:1.5},{count:9},{enabled:'false'},{tags:['a','a']},{tags:['other']},{name:'x'},{color:'blue'},{extra:true}])assert.throws(()=>schemaAPI.validate(schema,{...content,...patch}));
 assert.throws(()=>schemaAPI.validate(schema,{}),/请填写/);
 assert.throws(()=>schemaAPI.fields({type:'object',properties:{nested:{type:'object'}}}),/不受支持/);
 assert.throws(()=>schemaAPI.fields({type:'object',properties:{text:{type:'string',pattern:'.*'}}}),/不受支持/);
 assert.throws(()=>schemaAPI.fields(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}')),/无效/);
 assert.deepEqual(schemaAPI.answer({mode:'url',url:'https://example.com'},{action:'accept'}),{action:'accept'});
 assert.throws(()=>schemaAPI.answer({mode:'url',url:'javascript:alert(1)'},{action:'accept'}));
 assert.throws(()=>schemaAPI.fields({type:'object',properties:{text:{type:'string',oneOf:[{const:'x',pattern:'.*'}]}}}));
 assert.throws(()=>schemaAPI.fields({type:'object',properties:{count:{type:'integer',maximum:'4'}}}));
 assert.deepEqual(schemaAPI.answer({}, {action:'cancel'}),{action:'cancel'});
});
test('structured requests validate against the worker copy, reject stale/wrong-session replies and cancel on abort',async()=>{
 const service=new ChatService({load:()=>[],save(){}});
 try{
 const session=service.create({host:'axi'}),other=service.create({host:'axi'}),controller=new AbortController();
 const pending=service.requestElicitation(session,{serverName:'test',requestedSchema:schema},{signal:controller.signal,requestId:'remote-1'});
 const id=session.permissions[0].id;
 assert.equal(session.permissions[0].remoteRequestId,'remote-1');
 assert.throws(()=>service.respond(other.id,id,{interaction:{action:'accept',content}}));
 assert.throws(()=>service.respond(session.id,id,{interaction:{action:'accept',content:{...content,count:9}}}));
 assert.equal(session.permissions.length,1);
 service.respond(session.id,id,{interaction:{action:'accept',content}});
 assert.deepEqual({...((await pending).content)},content);
 assert.throws(()=>service.respond(session.id,id,{interaction:{action:'accept',content}}));
 const next=service.requestElicitation(session,{serverName:'test',requestedSchema:schema},{signal:controller.signal});
 controller.abort();assert.deepEqual(await next,{action:'cancel'});assert.equal(session.permissions.length,0);
 }finally{await service.close();}
});
