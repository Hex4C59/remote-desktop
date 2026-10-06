// Execute the actual generated page script with a small DOM facade. No browser,
// external files or real experiment data enter this identity regression check.
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const path = require('node:path');
const vm = require('node:vm');
const html = execFileSync('python3', ['-c', 'import software; print(software.REVIEW_HTML)'],
  {cwd: __dirname, encoding: 'utf8'});
const catalog = [{experiment:'exp',session:'session',operation_id:'0001',index_sha256:'index',
  expected_feedback:'test',phase:'formal',category:'test',gaps:[],end:{status:'captured'},
  action:{start_ns:'100'},frames:[{frame_id:1,observed_ns:'110',luma_delta:0,sha256:'first',image:'test.png'},
    {frame_id:2,observed_ns:'120',luma_delta:1,sha256:'second',image:'test.png'}]}];
const elements = new Map();
const context = vm.createContext({document:{getElementById(id){
  if(!elements.has(id)) elements.set(id,{value:'0',textContent:'',checked:false,append(){}});
  return elements.get(id);
},createElement(){return {}}}});
vm.runInContext(html.split('<script>')[1].split('</script>')[0].replace('__CATALOG__',JSON.stringify(catalog)),context);
const valid = {...catalog[0],status:'valid',last_absent:1,first_present:2,
  last_absent_sha256:'first',first_present_sha256:'second',reviewer:'test',rereviewer:'test',rereviewed:true};
async function importRows(rows){
  elements.get('import').files=[{text:async()=>JSON.stringify({schema:'software-review-v1',samples:rows})}];
  await elements.get('import').onchange();
}
(async()=>{
  for(const bad of [{...valid,session:'old'}, {...valid,index_sha256:'old'},
    {...valid,last_absent:999,last_absent_sha256:undefined},
    {...valid,last_absent:undefined,last_absent_sha256:undefined}]){
    await importRows([bad]);
    assert.match(elements.get('notice').textContent,/Import rejected/);
    assert.equal(vm.runInContext('records.size',context),0);
  }
  await importRows([valid,{...valid,session:'old'}]);
  assert.equal(vm.runInContext('records.size',context),0,'invalid batch is atomic');
  await importRows([valid]);
  assert.equal(vm.runInContext('records.size',context),1);
  assert.equal(elements.get('rereviewer').value,'test');
  console.log('review import identity/hash/boundary and atomic-batch checks passed');
})().catch(error=>{console.error(error);process.exitCode=1});
