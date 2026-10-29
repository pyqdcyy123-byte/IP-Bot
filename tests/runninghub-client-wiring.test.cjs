const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');

test('client.ts v2 path delegates nodeInfoList building to the shared pure module',()=>{
  const src=fs.readFileSync(path.join(root,'electron/mapi/runninghub/client.ts'),'utf8');
  assert.ok(/buildV2NodeInfoList/.test(src),'v2 createTask must use buildV2NodeInfoList from v2-task-payload.cjs instead of inline building');
});

test('NodeConfigEntry supports optional value for configured node field values',()=>{
  const src=fs.readFileSync(path.join(root,'electron/mapi/runninghub/client.ts'),'utf8');
  assert.ok(/id:\s*string;\s*fieldName\?:\s*string;\s*value\?:\s*string\s*\|\s*number/.test(src),'NodeConfigEntry must allow { id, fieldName, value }');
});
