import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { cleanup } from './helpers.mjs';

test('MCP discovery is immediate and failed setup returns an honest error',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'malyn-mcp-'));
  const client=new Client({name:'malyn-test',version:'0.1.0'});
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('src/server.mjs'),path.join(directory,'missing-config.json')]}));
    const discovered=await client.listTools();
    assert.deepEqual(discovered.tools.map(t=>t.name),['malyn']);
    const loops = await client.callTool({name:'malyn',arguments:{action:'loops'}});
    assert.equal(JSON.parse(loops.content[0].text).loops.length,5);
    const recipes=await client.callTool({name:'malyn',arguments:{action:'recipes'}});
    assert.equal(JSON.parse(recipes.content[0].text).recipes.length,5);
    const exported=await client.callTool({name:'malyn',arguments:{action:'export_recipe',recipe:'describe-my-image'}});
    const shared=JSON.parse(exported.content[0].text);
    assert.equal(shared.filename,'describe-my-image.md');
    const recipeFile=path.join(directory,'shared-image.md');
    await fs.writeFile(recipeFile,shared.markdown.replaceAll('describe-my-image','shared-image'));
    const imported=await client.callTool({name:'malyn',arguments:{action:'import_recipe',recipe_file:recipeFile}});
    assert.equal(JSON.parse(imported.content[0].text).executed,false);
    const loaded=await client.callTool({name:'malyn',arguments:{action:'recipe',recipe:'shared-image'}});
    assert.equal(JSON.parse(loaded.content[0].text).origin,'user');
    const result=await client.callTool({name:'malyn',arguments:{action:'status'}});
    assert.equal(result.isError,true);
    assert.match(result.content[0].text,/ENOENT/);
  }finally{await client.close();await cleanup(directory);}
});

test('MCP never reads arbitrary job IDs outside its job directory',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'malyn-job-'));
  const config=path.join(directory,'config.json');
  await fs.writeFile(config,JSON.stringify({lmsPath:'not-invoked',modelKey:'not-invoked'}));
  const client=new Client({name:'malyn-test',version:'0.1.0'});
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('src/server.mjs'),config]}));
    const result=await client.callTool({name:'malyn',arguments:{action:'check',job_id:'../outside'}});
    assert.equal(result.isError,true);
    assert.match(result.content[0].text,/Invalid job ID/);
    const badRoot=await client.callTool({name:'malyn',arguments:{action:'submit',task:'read stuff',root:'.'}});
    assert.equal(badRoot.isError,true);
    assert.match(badRoot.content[0].text,/absolute root/);
  }finally{await client.close();await cleanup(directory);}
});
