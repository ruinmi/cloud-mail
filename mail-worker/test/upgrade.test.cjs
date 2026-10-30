const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
function load(source, name, dependencies = {}) {
  source = source.replace(/^import[\s\S]*?;\s*$/gm, '').replace(/^export[^\n]*/gm, '');
  return vm.runInNewContext(source + '\n' + name, { console: {warn(){}}, ...dependencies });
}
const read = p => readFileSync(path.join(root, p), 'utf8');
function context(db) {
  function statement(sql, args = []) {
    return {
      bind(...values) { return statement(sql, values); },
      async run() { return db.prepare(sql).run(...args); },
      async first() { return db.prepare(sql).get(...args) || null; },
      async all() { return {results: db.prepare(sql).all(...args)}; }
    };
  }
  return { env: {jwt_secret:'test', db: {prepare: statement, async batch(statements) {
    db.exec('BEGIN');
    try { const result = []; for (const s of statements) result.push(await s.run()); db.exec('COMMIT'); return result; }
    catch(e) {db.exec('ROLLBACK'); throw e;}
  }}}, req: {param:()=> 'test'}, text: x=>x };
}
const dependencies = {settingService:{async refresh(){}}, emailUtils:{getName:x=>x.split('@')[0]}, emailConst:{type:{RECEIVE:0}}};
async function migrationTest() {
  const oldSource = execFileSync('git', ['show','1274826:mail-worker/src/init/init.js'], {cwd:root, encoding:'utf8'});
  const oldInit = load(oldSource, 'dbInit', dependencies);
  const current = load(read('mail-worker/src/init/init.js'), 'dbInit', dependencies);
  const db = new DatabaseSync(':memory:');
  const c = context(db);
  assert.equal(await oldInit.init(c), 'success');
  db.exec("INSERT INTO account(email,user_id,group_name) VALUES('existing@example.com',7,'工作'); INSERT INTO email(send_email,account_id,user_id,subject,content) VALUES('sender@example.net',1,7,'existing subject','existing body')");
  for (let i=0;i<2;i++) {
    assert.equal(await current.init(c),'success');
    assert.equal(db.prepare('SELECT group_name FROM account WHERE account_id=1').get().group_name,'工作');
    assert.equal(db.prepare('SELECT content FROM email WHERE email_id=1').get().content,'existing body');
    for (const column of ['code','sender_email']) assert(db.prepare("SELECT name FROM pragma_table_info('email') WHERE name=?").get(column));
    for (const column of ['linuxdo_client_id','webhook_url','auto_clean_days','sync_delete','ai_code']) assert(db.prepare("SELECT name FROM pragma_table_info('setting') WHERE name=?").get(column));
  }
  const fresh = new DatabaseSync(':memory:');
  assert.equal(await current.init(context(fresh)),'success');
  c.env.linuxdo_client_id = 'legacy-client';
  c.env.linuxdo_client_secret = 'legacy-secret';
  c.env.linuxdo_switch = 'true';
  await current.init(c);
  assert.equal(db.prepare('SELECT linuxdo_client_id FROM setting').get().linuxdo_client_id,'legacy-client');
  assert.equal(db.prepare('SELECT linuxdo_switch FROM setting').get().linuxdo_switch,0);
  db.exec("UPDATE setting SET linuxdo_client_id='new-client',linuxdo_client_secret='new-secret',linuxdo_switch=1");
  await current.init(c);
  assert.equal(db.prepare('SELECT linuxdo_client_id FROM setting').get().linuxdo_client_id,'new-client');
  assert.equal(db.prepare('SELECT linuxdo_switch FROM setting').get().linuxdo_switch,1);
  console.log('PASS: old database upgrade, repeated upgrade, fresh database; preserved group and email content');
}
async function externalTests() {
  class BizError extends Error {constructor(message, status){super(message);this.status=status;}}
  const source = read('mail-worker/src/service/external-service.js');
  for (const channel of ['internal','resend','cloudflare']) {
    const calls = [];
    let inserted;
    const service = load(source, 'externalService', {
      BizError, t:x=>x, email:{},
      emailConst:{type:{SEND:1},status:{DELIVERED:2,SENT:1}},settingConst:{send:{CLOSE:1}},
      verifyUtils:{isEmail:x=>typeof x==='string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)},
      emailUtils:{getDomain:x=>x.split('@')[1],getName:x=>x.split('@')[0]},
      settingService:{query:async()=>({send:0,domainList:['@example.com'],resendTokens:{'example.com':'test-token'}})},
      accountService:{selectByEmailIncludeDel:async()=>({userId:7,accountId:2})},
      userService:{selectByEmail:async()=>({userId:1})},
      emailService:{sendByCloudflareEmail:async(c,p)=>{calls.push('cloudflare');return {data:{id:'cf-id'}};},sendByResend:async(t,p)=>{calls.push('resend');return {data:{id:'resend-id'}};},HandleOnSiteEmail:async()=>calls.push('internal')},
      attService:{saveSendAtt:async()=>{},selectByEmailIds:async()=>[]},
      orm:()=>({insert:()=>({values: data=>{inserted=data;return {returning:()=>({get:async()=>({...data,emailId:11})})};}})}),
      dayjs:()=>({format:()=> '2026-10-30'}),kvConst:{SEND_DAY_COUNT:'send:'}
    });
    const c = {env:{domain:['example.com'],admin:'admin@example.com',kv:{get:async()=>null,put:async()=>{}}}};
    if(channel==='cloudflare')c.env.email={};
    const params = {from:'sender@example.com',to:channel==='internal'?'receiver@example.com':'receiver@example.net',subject:'test',text:'hello'};
    const result = await service.sendEmail(c,params);
    assert.equal(result.channel,channel);assert.equal(calls.join(','),channel);assert.equal(inserted.userId,7);
    assert.throws(()=>service.validateRequest(c,{...params,from:'sender@untrusted.net',attachments:[]}), /externalFromDomainInvalid/);
    assert.throws(()=>service.validateRequest(c,{...params,to:'invalid',attachments:[]}), /notEmail/);
  }
  console.log('PASS: external API internal, Resend and Cloudflare paths, ownership, invalid domains and recipients');
}
const {test} = require('node:test');
test('upgrade preserves existing data and legacy OAuth configuration', migrationTest);
test('external send API preserves delivery channels and validation', externalTests);
