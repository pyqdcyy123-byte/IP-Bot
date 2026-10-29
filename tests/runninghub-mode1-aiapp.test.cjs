const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');
const AI_APP='2044675464228245506';

test('mode1 (节点01) defaults point to the lip-sync AI app with v2 API',()=>{
  const main=fs.readFileSync(path.join(root,'electron/mapi/runninghub/main.ts'),'utf8');
  assert.ok(main.includes(`|| '${AI_APP}'`),'main.ts workflowId1 default must be the AI app id');
  const m1=main.slice(main.indexOf('workflowId: workflowId1,'),main.indexOf('return clientInstance1;'));
  assert.ok(m1.length>0 && m1.length<600,'mode1 construction block must exist');
  assert.ok(/apiVersion:\s*'v2'/.test(m1),'mode1 client must use v2 (AI app endpoint)');
  const nodes=main.slice(main.indexOf('const defaultMode1Nodes'),main.indexOf('const defaultMode2Nodes'));
  assert.ok(nodes.includes(`'${AI_APP}'`)===false,'nodes config must not embed app id');
  assert.ok(nodes.includes(`id: '228'`)&&nodes.includes(`fieldName: 'video'`),'mode1 default nodes must map video to node 228');
  assert.ok(nodes.includes(`id: '125'`)&&nodes.includes(`fieldName: 'audio'`),'mode1 default nodes must map audio to node 125');
});

test('server.js seed default for workflow_id_1 points to the AI app',()=>{
  const server=fs.readFileSync(path.join(root,'user-server/server.js'),'utf8');
  assert.ok(server.includes(`sensitiveConfig.RUNNINGHUB_WORKFLOW_ID_1 || '${AI_APP}'`),'server.js seed must default workflow_id_1 to the AI app');
});
