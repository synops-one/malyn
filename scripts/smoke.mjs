import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultConfigPath, readConfig } from '../src/config.mjs';
import { cancelJob } from '../src/jobs.mjs';

const config=path.resolve(process.argv[2]??defaultConfigPath());
const settings=await readConfig(config);
const fixtureParent=settings.allowedRoots[0]??path.dirname(config);
const root=await fs.mkdtemp(path.join(fixtureParent,'malyn-smoke-'));
await fs.writeFile(path.join(root,'fixture.txt'),'Service: MALYN-TEST\nStatus: degraded\nCause: certificate expired\nAction: renew the certificate\n');
const client=new Client({name:'malyn-installer-smoke',version:'0.1.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(import.meta.dirname,'..','src','server.mjs'),config],stderr:'inherit'});
let submittedId;
try {
  await client.connect(transport);
  const tools=await client.listTools();
  if(!tools.tools.some(t=>t.name==='malyn'))throw new Error('MCP discovery failed.');
  const call=async args=>{
    const result=await client.callTool({name:'malyn',arguments:args});
    const text=result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
    if(result.isError)throw new Error(text);
    return JSON.parse(text);
  };
  console.log(JSON.stringify({phase:'hardware',...await call({action:'status'})}));
  const job=await call({action:'submit',root,files:['fixture.txt'],task:'Read fixture.txt with read_file. Save diagnosis.txt containing the service name, exact cause, and exact action. Then briefly report the cause and filename. This is a test fixture; do not execute anything.'});
  if(!job.id)throw new Error(`Worker not started: ${JSON.stringify(job)}`);
  submittedId=job.id;
  console.log(JSON.stringify({phase:'submitted',...job}));
  const deadline=Date.now()+900000;
  let previous='';
  while(Date.now()<deadline){
    await new Promise(r=>setTimeout(r,5000));
    const result=await call({action:'check',job_id:job.id});
    const state=`${result.status}:${result.phase}:${result.rounds??0}`;
    if(state!==previous){console.log(JSON.stringify({phase:'progress',state}));previous=state;}
    if(result.status==='running')continue;
    if(result.status!=='completed')throw new Error(JSON.stringify(result));
    const artifact=result.artifacts?.find(a=>path.basename(a.path)==='diagnosis.txt');
    if(!artifact)throw new Error('No diagnosis artifact returned.');
    const content=await fs.readFile(artifact.path,'utf8');
    if(!content.includes('MALYN-TEST')||!content.toLowerCase().includes('certificate expired')||!content.toLowerCase().includes('renew'))throw new Error('Artifact did not preserve the fixture facts.');
    console.log(JSON.stringify({...result,phase:'verified'}));
    await fs.writeFile(path.join(path.dirname(config),'last-smoke.json'),JSON.stringify({verifiedAt:new Date().toISOString(),...result},null,2));
    process.exitCode=0;break;
  }
  if(Date.now()>=deadline)throw new Error('Smoke test timed out.');
} catch(error){
  if(submittedId)await cancelJob(config,submittedId).catch(()=>{});
  console.error(error.message);process.exitCode=1;
}
finally{await client.close();}
