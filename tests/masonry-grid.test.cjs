const {test}=require('node:test');
const assert=require('node:assert/strict');
const {computeRowSpan}=require('../src/lib/masonry-grid.cjs');

test('row span covers the element height plus one row gap, rounded up',()=>{
  // unit=8, gap=14 → each span step consumes 8+14=22px
  assert.equal(computeRowSpan(0,8,14),1);
  assert.equal(computeRowSpan(8,8,14),1);
  assert.equal(computeRowSpan(30,8,14),2);   // 30+14=44 → ceil(44/22)=2
  assert.equal(computeRowSpan(1022,8,14),48);
  assert.equal(computeRowSpan(1261,8,14),58);
});

test('row span stays at least 1 and handles zero row gap',()=>{
  assert.equal(computeRowSpan(1,8,0),1);
  assert.equal(computeRowSpan(16,8,0),2);
  assert.equal(computeRowSpan(17,8,0),3);
});

test('VideoIPAgent.vue wires the masonry spans with a ResizeObserver and cleans up on unmount',()=>{
  const fs=require('node:fs'),path=require('node:path');
  const src=fs.readFileSync(path.join(__dirname,'../src/pages/Video/VideoIPAgent.vue'),'utf8');
  assert.ok(/masonry-grid\.cjs/.test(src),'must import computeRowSpan from the shared module');
  assert.ok(/ResizeObserver/.test(src),'must observe column height changes');
  assert.ok(/studio-creation-grid/.test(src),'must target the creation grid');
  assert.ok(/disconnect\(\)/.test(src),'must disconnect the observer on unmount');
});
