const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildChatCompletionsUrl}=require('../src/module/Model/provider/chat-url.cjs');

test('host ending with version segment gets /chat/completions appended (no extra /v1)',()=>{
  assert.equal(buildChatCompletionsUrl('https://ark.cn-beijing.volces.com/api/coding/v3'),'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions');
  assert.equal(buildChatCompletionsUrl('https://example.com/v1'),'https://example.com/v1/chat/completions');
  assert.equal(buildChatCompletionsUrl('https://example.com/api/v3'),'https://example.com/api/v3/chat/completions');
});

test('dashscope compatible-mode hosts no longer get a duplicated /v1',()=>{
  assert.equal(buildChatCompletionsUrl('https://dashscope.aliyuncs.com/compatible-mode/v1'),'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
});

test('trailing slash appends chat/completions directly (legacy behavior preserved)',()=>{
  assert.equal(buildChatCompletionsUrl('https://ark.cn-beijing.volces.com/api/v3/'),'https://ark.cn-beijing.volces.com/api/v3/chat/completions');
});

test('full endpoint passes through unchanged',()=>{
  assert.equal(buildChatCompletionsUrl('https://example.com/v1/chat/completions'),'https://example.com/v1/chat/completions');
});

test('bare host keeps legacy /v1/chat/completions default',()=>{
  assert.equal(buildChatCompletionsUrl('https://api.openai.com'),'https://api.openai.com/v1/chat/completions');
  assert.equal(buildChatCompletionsUrl('https://example.com/api'),'https://example.com/api/v1/chat/completions');
});

test('provider.ts delegates URL building to the shared module',()=>{
  const fs=require('node:fs'),path=require('node:path');
  const src=fs.readFileSync(path.join(__dirname,'../src/module/Model/provider/provider.ts'),'utf8');
  assert.ok(/chat-url\.cjs/.test(src),'provider.ts must import chat-url.cjs instead of inlining the switch');
});

test('VideoIPAgent.vue delegates URL building to the shared module',()=>{
  const fs=require('node:fs'),path=require('node:path');
  const src=fs.readFileSync(path.join(__dirname,'../src/pages/Video/VideoIPAgent.vue'),'utf8');
  assert.ok(/buildChatCompletionsUrl/.test(src),'VideoIPAgent.vue must reuse buildChatCompletionsUrl instead of 6 inline copies');
  assert.ok(!/\/v1\/chat\/completions`\;/.test(src),'inline /v1/chat/completions interpolation must be removed');
});
