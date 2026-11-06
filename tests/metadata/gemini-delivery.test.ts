import { test, expect } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { geminiStatPin } from "../../src/metadata/gemini-json";
import { hash } from "../../src/metadata/stream";
const driver = `import subprocess,json,sys
p=subprocess.Popen(sys.argv[1:5],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
p.stdout.close()
if sys.argv[5]=='both': p.stderr.close(); err=b''; p.wait(timeout=20)
else: err=p.stderr.read(); p.wait(timeout=20)
print(json.dumps({'exit':p.returncode,'stderr':err.decode('utf-8','replace')}))`;
for(const mode of ["stdout","both","invalid"] as const) test(`real closed ${mode} pipe preserves publication truth`,()=>{
  const dir=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"gemini-delivery-"))),path=join(dir,"chat.json"),input=join(dir,"input.json"),out=join(dir,"out");
  try {
    const raw=Buffer.from('{"sessionId":"synthetic","messages":[{"id":"x","type":"gemini","tokens":{"input":1,"output":0}}]}');
    fs.writeFileSync(path,raw,{mode:0o600});
    const source={path,provider:"gemini-cli",sourceFormat:"gemini-chat-json",coordinateKind:"json-utf8-span-v1",admission:"synthetic",custodyMachine:"synthetic-custody",originMachine:"UNKNOWN",originProof:"UNKNOWN",originalPath:"UNKNOWN",sourceRoot:dir,rootKind:"native-gemini-cli-tmp",documentBytes:raw.length,documentHash:mode==="invalid"?"a".repeat(64):hash(raw),stat:geminiStatPin(fs.lstatSync(path,{bigint:true}))};
    fs.writeFileSync(input,JSON.stringify({version:1,kind:"tokenlayer-gemini-json-export-input",scope:"synthetic-only",maxOutputRows:1,expectedMessages:1,expectedSessionId:"synthetic",source}),{mode:0o600});
    const child=Bun.spawnSync(["python3","-c",driver,process.execPath,resolve("src/metadata/gemini-main.ts"),input,out,mode]);
    expect(child.exitCode).toBe(0);const result=JSON.parse(child.stdout.toString());
    expect(result.stderr).not.toMatch(/Unhandled|broken pipe|\n\s+at |synthetic-custody|chat.json/);
    if(mode==="invalid") {expect(result.exit).toBe(1);expect(fs.existsSync(join(out,"manifest.json"))).toBe(false);}
    else {
      expect(result.exit).toBe(2);
      const receipt=JSON.parse(fs.readFileSync(join(out,"manifest.json"),"utf8")),bytes=fs.readFileSync(join(out,"metadata.ndjson"));
      expect(receipt).toMatchObject({exportComplete:true,complete:false,consumption:"PARTIAL_METADATA_ONLY",sourceAcceptance:"HOLD"});
      expect(receipt.outputs).toEqual({metadataSha256:hash(bytes),metadataBytes:bytes.length});
      if(mode==="stdout") expect(result.stderr).toBe("COMMITTED:SUMMARY_DELIVERY_FAILED; validate the final manifest\n");
    }
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
