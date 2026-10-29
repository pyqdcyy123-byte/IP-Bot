const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');
test('T1 TTS branch fails loudly when cloned voice lacks aliyunVoiceId (prevents 418 from voice/model mismatch)',()=>{
 const src=fs.readFileSync(path.join(root,'src/pages/Video/VideoIPAgent.vue'),'utf8');
 assert.ok(!/aliyunVoiceId\s*\|\|\s*'longyingxiao'/.test(src),'T1 branch must not silently fall back to longyingxiao');
 assert.ok(/该音色尚未完成克隆注册/.test(src),'T1 branch must throw a clear error when aliyunVoiceId is missing');
});
test('voice enrollment falls back to Base64 Data URI instead of requiring OSS',()=>{
 const src=fs.readFileSync(path.join(root,'electron/mapi/aliyun/enrollment.ts'),'utf8');
 assert.ok(/data:audio\/wav;base64,/.test(src),'enrollment must support Base64 Data URI submission');
 assert.ok(!/缺少 OSS 配置，无法上传复刻音频/.test(src),'enrollment must not hard-require OSS config');
});
