const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildV2NodeInfoList}=require('../electron/mapi/runninghub/v2-task-payload.cjs');

const BASE_NODES={
  videoNode:{id:'228',fieldName:'video'},
  audioNode:{id:'125',fieldName:'audio'}
};

test('video/audio nodes use configured id and fieldName with uploaded file names',()=>{
  const list=buildV2NodeInfoList(BASE_NODES,{videoFileName:'a.mp4',audioFileName:'b.mp3'});
  assert.deepEqual(list,[
    {nodeId:'228',fieldName:'video',fieldValue:'a.mp4',description:'请导入视频'},
    {nodeId:'125',fieldName:'audio',fieldValue:'b.mp3',description:'请导入新的音频'}
  ]);
});

test('width/height nodes honor configured value instead of hardcoded defaults',()=>{
  const list=buildV2NodeInfoList({
    ...BASE_NODES,
    widthNode:{id:'345',fieldName:'value',value:720},
    heightNode:{id:'344',fieldName:'value',value:1280}
  },{videoFileName:'a.mp4',audioFileName:'b.mp3'});
  assert.ok(list.some(n=>n.nodeId==='345'&&n.fieldValue==='720'));
  assert.ok(list.some(n=>n.nodeId==='344'&&n.fieldValue==='1280'));
});

test('width/height nodes fall back to legacy hardcoded defaults when no value configured',()=>{
  const list=buildV2NodeInfoList({
    ...BASE_NODES,
    widthNode:{id:'w',fieldName:'int'},
    heightNode:{id:'h',fieldName:'int'}
  },{videoFileName:'a.mp4',audioFileName:'b.mp3'});
  assert.ok(list.some(n=>n.nodeId==='w'&&n.fieldValue==='576'));
  assert.ok(list.some(n=>n.nodeId==='h'&&n.fieldValue==='1024'));
});

test('fps node defaults to 30 and honors configured override',()=>{
  const def=buildV2NodeInfoList({...BASE_NODES,fpsNode:{id:'f',fieldName:'value'}},{videoFileName:'a.mp4',audioFileName:'b.mp3'});
  assert.ok(def.some(n=>n.nodeId==='f'&&n.fieldValue==='30'));
  const ov=buildV2NodeInfoList({...BASE_NODES,fpsNode:{id:'f',fieldName:'value',value:'25'}},{videoFileName:'a.mp4',audioFileName:'b.mp3'});
  assert.ok(ov.some(n=>n.nodeId==='f'&&n.fieldValue==='25'));
});

test('duration node without value sends ceil seconds (legacy behavior)',()=>{
  const list=buildV2NodeInfoList({...BASE_NODES,durationNode:{id:'d',fieldName:'value'}},{videoFileName:'a.mp4',audioFileName:'b.mp3',audioDuration:9.2});
  assert.ok(list.some(n=>n.nodeId==='d'&&n.fieldValue==='10'));
});

test('duration node value template interpolates {{audioDuration}} as ceil seconds',()=>{
  const list=buildV2NodeInfoList({
    ...BASE_NODES,
    durationNode:{id:'342',fieldName:'text',value:'0:{{audioDuration}}'}
  },{videoFileName:'a.mp4',audioFileName:'b.mp3',audioDuration:10.4});
  assert.ok(list.some(n=>n.nodeId==='342'&&n.fieldName==='text'&&n.fieldValue==='0:11'));
});

test('duration node is skipped when no audioDuration provided',()=>{
  const list=buildV2NodeInfoList({...BASE_NODES,durationNode:{id:'d',fieldName:'value'}},{videoFileName:'a.mp4',audioFileName:'b.mp3'});
  assert.ok(!list.some(n=>n.nodeId==='d'));
});

test('text node included only when text provided',()=>{
  const nodes={...BASE_NODES,textNode:{id:'347',fieldName:'text'}};
  const withText=buildV2NodeInfoList(nodes,{videoFileName:'a.mp4',audioFileName:'b.mp3',text:'人物在说话'});
  assert.ok(withText.some(n=>n.nodeId==='347'&&n.fieldValue==='人物在说话'));
  const withoutText=buildV2NodeInfoList(nodes,{videoFileName:'a.mp4',audioFileName:'b.mp3'});
  assert.ok(!withoutText.some(n=>n.nodeId==='347'));
});

test('extraNodes entries are appended with {{audioDuration}} interpolation; malformed entries skipped',()=>{
  const list=buildV2NodeInfoList({
    ...BASE_NODES,
    extraNodes:[
      {nodeId:'901',fieldName:'value',fieldValue:'{{audioDuration}}'},
      {nodeId:'',fieldName:'value',fieldValue:'x'},
      {fieldName:'value',fieldValue:'y'}
    ]
  },{videoFileName:'a.mp4',audioFileName:'b.mp3',audioDuration:8});
  const extras=list.filter(n=>n.nodeId==='901');
  assert.equal(extras.length,1);
  assert.equal(extras[0].fieldValue,'8');
  assert.equal(list.filter(n=>n.nodeId==='').length,0);
});

test('maxSide/audioStart nodes send legacy defaults; audioEnd follows audioDuration',()=>{
  const list=buildV2NodeInfoList({
    ...BASE_NODES,
    maxSideNode:{id:'m',fieldName:'int'},
    audioStartNode:{id:'s',fieldName:'int'},
    audioEndNode:{id:'e',fieldName:'int'}
  },{videoFileName:'a.mp4',audioFileName:'b.mp3',audioDuration:12.9});
  assert.ok(list.some(n=>n.nodeId==='m'&&n.fieldValue==='1024'));
  assert.ok(list.some(n=>n.nodeId==='s'&&n.fieldValue==='0'));
  assert.ok(list.some(n=>n.nodeId==='e'&&n.fieldValue==='13'));
});

test('accepts resolved {nodeId, fieldName} shape as passed from client.ts (regression: nodeId must not be dropped)',()=>{
  const list=buildV2NodeInfoList({
    videoNode:{nodeId:'228',fieldName:'video'},
    audioNode:{nodeId:'125',fieldName:'audio'},
    durationNode:{nodeId:'342',fieldName:'text',value:'0:{{audioDuration}}'}
  },{videoFileName:'a.mp4',audioFileName:'b.mp3',audioDuration:10});
  assert.equal(list[0].nodeId,'228');
  assert.equal(list[1].nodeId,'125');
  assert.equal(list[2].nodeId,'342');
  assert.equal(list[2].fieldValue,'0:10');
  assert.ok(list.every(n=>typeof n.nodeId==='string'&&n.nodeId.length>0),'every entry must carry a nodeId');
});
