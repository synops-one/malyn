import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec=promisify(execFile);
const ps=(...args)=>exec('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',...args],{windowsHide:true,timeout:15000});
const quote=value=>`'${value.replaceAll("'","''")}'`;

test('Explorer registration migrates owned commands, keeps long paths out of the verb and passes filenames literally', {skip:process.platform!=='win32'}, async()=>{
  const temporaryRoot=path.resolve('build');
  await fs.mkdir(temporaryRoot,{recursive:true});
  const directory=await fs.realpath(await fs.mkdtemp(path.join(temporaryRoot,'malyn-explorer-')));
  const config=path.join(directory,'settings.json');
  const cli=path.join(directory,'a long installation directory with spaces and symbols & '+ 'x'.repeat(60),'fake-cli.mjs');
  const capture=path.join(directory,'arguments.json');
  const input=path.join(directory,"sample & $(literal) 'notes'.txt");
  await fs.mkdir(path.dirname(cli));
  await fs.writeFile(cli,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));`);
  await fs.writeFile(config,'{}');
  await fs.writeFile(input,'Synthetic fixture');
  const run=async action=>JSON.parse((await ps('-File',path.resolve('scripts/Malyn-Explorer.ps1'),'-Action',action,'-NodePath',process.execPath,'-CliPath',cli,'-ConfigPath',config)).stdout);
  const recordFile=path.join(directory,'explorer-registration.json');
  let restoreCommand;
  try {
    assert.equal((await run('Status')).askInExplorer,false);
    assert.equal((await run('Enable')).managed,true);
    let record=JSON.parse(await fs.readFile(recordFile,'utf8'));
    assert.ok(record.command.length<520);
    assert.ok(!record.command.includes(cli));
    assert.match(record.command,/-RegistrationPath ".+" -InputPath "%1"$/);
    assert.equal(record.nodePath,process.execPath);
    assert.equal(record.cliPath,cli);
    assert.equal(record.configPath,config);
    await ps('-File',path.resolve('scripts/Ask-Malyn.ps1'),'-RegistrationPath',recordFile,'-InputPath',input);
    assert.deepEqual(JSON.parse(await fs.readFile(capture,'utf8')),['ask',input,'--config',config]);

    const registryPath=`\\Software\\Classes\\*\\shell\\${record.name}\\command`;
    const writeCommand=command=>ps('-Command',`$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$r=Invoke-CimMethod -Namespace root/default -ClassName StdRegProv -MethodName SetStringValue -Arguments @{hDefKey=[uint32]2147483651;sSubKeyName=($sid+${quote(registryPath)});sValueName='';sValue=${quote(command)}};if($r.ReturnValue -ne 0){throw 'Registry update failed'}`);
    const oldCommand='"old-owned-launcher.exe" "%1"';
    await writeCommand(oldCommand);
    await fs.writeFile(recordFile,JSON.stringify({name:record.name,command:oldCommand}));
    assert.equal((await run('Sync')).managed,true);
    record=JSON.parse(await fs.readFile(recordFile,'utf8'));
    assert.equal(record.cliPath,cli);
    restoreCommand=()=>writeCommand(record.command);
    await writeCommand('"changed-by-someone-else.exe" "%1"');
    await assert.rejects(()=>run('Enable'),/changed outside Malyn/);
    await assert.rejects(()=>run('Disable'),/changed outside Malyn/);
    await restoreCommand();restoreCommand=undefined;
    assert.equal((await run('Disable')).askInExplorer,false);
    assert.equal((await run('Sync')).askInExplorer,false);
  } finally {
    if(restoreCommand)await restoreCommand();
    await run('Disable');
    if(path.dirname(path.resolve(directory))!==temporaryRoot || !path.basename(directory).startsWith('malyn-explorer-'))throw new Error('Unexpected Explorer test cleanup target.');
    await fs.rm(directory,{recursive:true,force:true});
  }
});
