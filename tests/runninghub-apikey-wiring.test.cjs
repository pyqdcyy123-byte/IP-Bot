const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');

test('every RunningHubClient construction in main.ts receives the configured apiKey',()=>{
  const src=fs.readFileSync(path.join(root,'electron/mapi/runninghub/main.ts'),'utf8');
  const parts=src.split('new RunningHubClient(');
  // parts[0] is the text before the first construction
  assert.ok(parts.length>=8,'expected at least 7 client constructions, found '+(parts.length-1));
  let checked=0;
  for(let i=1;i<parts.length;i++){
    const block=parts[i].split('});')[0];
    if(!block.includes('workflowId:')) continue; // ignore unrelated constructions
    assert.ok(/\bapiKey\b/.test(block),`client construction #${i} must pass apiKey (mode clients without it fail with "API Key 未配置"): ${block.slice(0,120)}`);
    checked++;
  }
  assert.ok(checked>=7,'expected >=7 workflow client constructions with apiKey, checked '+checked);
});
