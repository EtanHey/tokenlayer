import { test, expect } from "bun:test";

test("S-9 Drive member streaming selects the expected repeated member without disk extraction", () => {
  const code = `import importlib.util,io,tarfile,hashlib,sys
assert sys.dont_write_bytecode, "Python fixture must disable bytecode writes"
spec=importlib.util.spec_from_file_location('drive_stream','src/archaeology/drive-stream.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
out=io.BytesIO()
with tarfile.open(fileobj=out,mode='w:gz') as archive:
 for value in [b'first\\n',b'second\\n']:
  info=tarfile.TarInfo('session.jsonl');info.size=len(value);archive.addfile(info,io.BytesIO(value))
body=out.getvalue();target=io.BytesIO()
m.stream_bytes(io.BytesIO(body),target,hashlib.sha256(body).hexdigest(),hashlib.md5(body).hexdigest(),'session.jsonl',hashlib.sha256(b'second\\n').hexdigest())
assert target.getvalue()==b'second\\n'
print('stream fixture passed')`;
  const proc=Bun.spawnSync(["python3","-c",code],{stdout:"pipe",stderr:"pipe",env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"}});
  expect(proc.exitCode).toBe(0);expect(proc.stdout.toString()).toBe("stream fixture passed\n");
});
