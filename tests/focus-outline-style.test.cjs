const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');

test('themed focus-visible outline must not paint a floating ring on text fields (they have their own focus styles)',()=>{
  const css=fs.readFileSync(path.join(root,'src/assets/styles/apple-system.css'),'utf8');
  assert.ok(/:focus-visible/.test(css),'global focus-visible rule must exist');
  const exclusion=css.match(/body\[data-theme\]\s*:is\(([^)]*)\):focus-visible[^{]*\{[^}]*\}/);
  assert.ok(exclusion,'must exclude text fields from the global focus-visible outline');
  // bare element selectors required: .arco-textarea containing the substring would not cover a native <textarea>
  assert.match(exclusion[1],/(^|[,\s])textarea(?=$|[,\s])/,'exclusion must cover bare native textarea');
  assert.match(exclusion[1],/(^|[,\s])input(?=$|[,\s])/,'exclusion must cover bare native input');
  assert.match(exclusion[0],/outline:\s*none/,'exclusion must remove the outline');
  assert.match(exclusion[0],/!important/,'exclusion must override the !important global rule');
});

test('dark-input-override focus ring must paint only the wrapper, not also the inner input (double-ring bug)',()=>{
  const css=fs.readFileSync(path.join(root,'src/assets/styles/elegant-theme.css'),'utf8');
  const rules=css.split('}');
  for(const rule of rules){
    const selector=rule.split('{')[0]||'';
    if(/\.dark-input-override:focus-within\s+\.arco-(input|textarea|select-view)/.test(selector)){
      assert.doesNotMatch(rule,/box-shadow/,'inner element of dark-input-override must not get its own focus box-shadow: '+selector.trim().slice(0,80));
    }
  }
  assert.ok(/\.dark-input-override:focus-within\s*\{/.test(css.replace(/\s+/g,' ')),'wrapper focus ring must remain');
});

test('no theme rule may paint a focus box-shadow directly on inner input/textarea elements (ring belongs on the wrapper)',()=>{
  const files=['src/assets/styles/elegant-theme.css','src/assets/styles/app-theme.less','src/assets/styles/apple-system.css','src/assets/styles/studio-system.css'];
  for(const f of files){
    const css=fs.readFileSync(path.join(root,f),'utf8');
    const rules=css.split('}');
    for(const rule of rules){
      const selector=(rule.split('{')[0]||'');
      if(!/box-shadow/.test(rule))continue;
      // inner text-entry elements targeted directly with :focus must not get a box-shadow
      assert.doesNotMatch(selector,/\.arco-(input|textarea):focus(?![\w-])|:focus-within\s+\.arco-(input|textarea)\b/,
        f+' paints focus box-shadow directly on an inner input/textarea: '+selector.trim().slice(0,100));
    }
  }
});
