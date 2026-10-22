import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { binaries, runBinary, probeMedia, planFrames, extractFrames, normalizeSettings } from '../lib/media.js';
import { createTool, sessionFiles, assertVision, copySource, renderResult } from '../lib/index.js';
export const root = fileURLToPath(new URL('./fixtures/', import.meta.url));
const bin = binaries();
function word(n) { return [n & 255, n >> 8]; }
function gifImage(x,y,w,h,pixels,delay,disposal=1) {
  const codes = pixels.flatMap(p => [4,p]); codes.push(5);
  let bits=0,n=0,bytes=[];
  for(const code of codes){bits|=code<<n;n+=3;while(n>=8){bytes.push(bits&255);bits>>=8;n-=8;}}
  if(n)bytes.push(bits&255);
  return [0x21,0xf9,4,(disposal<<2)|1,...word(delay),0,0,0x2c,...word(x),...word(y),...word(w),...word(h),0,2,bytes.length,...bytes,0];
}
export async function fixtures() {
  await fs.mkdir(root,{recursive:true});
  const gif = path.join(root,'中文 unequal disposal.gif');
  const bytes=[...Buffer.from('GIF89a'),...word(4),...word(2),0x81,0,0,0,0,0,255,0,0,0,255,0,0,0,255,
    0x21,0xff,11,...Buffer.from('NETSCAPE2.0'),3,1,0,0,0,
    ...gifImage(0,0,4,2,Array(8).fill(1),10),
    ...gifImage(0,0,2,2,Array(4).fill(2),70,2),
    ...gifImage(2,0,2,2,Array(4).fill(3),20,3),
    ...gifImage(0,0,1,1,[2],30),0x3b];
  await fs.writeFile(gif,Buffer.from(bytes));
  const video=path.join(root,'中文 sample.mp4');
  await runBinary(bin.ffmpeg,['-v','error','-y','-f','lavfi','-i','testsrc2=size=96x64:rate=10:duration=3','-an','-c:v','mpeg4','-q:v','2',video]);
  const vfr=path.join(root,'held-vfr.mkv');
  await runBinary(bin.ffmpeg,['-v','error','-y','-f','lavfi','-i','testsrc2=size=96x64:rate=1:duration=3','-vf',"setpts='if(eq(N,0),0,if(eq(N,1),2/TB,10/TB))'",'-fps_mode','vfr','-c:v','ffv1',vfr]);
  const offset=path.join(root,'nonzero-start.mp4');
  await runBinary(bin.ffmpeg,['-v','error','-y','-i',video,'-c','copy','-output_ts_offset','10',offset]);
  return {gif,video,vfr,offset};
}
const samples = await fixtures();
const signal=()=>new AbortController().signal;
function pixels(file) {
  const result=spawnSync(bin.ffmpeg,['-v','error','-i',file,'-f','rawvideo','-pix_fmt','rgba','pipe:1'],{windowsHide:true});
  assert.equal(result.status,0,result.stderr.toString());return result.stdout;
}
test('GIF unequal delays, disposal 2/3 and alpha survive one-loop extraction',async()=>{
  const info=await probeMedia(samples.gif);
  assert.deepEqual(info.frameTimes,[0,.1,.8,1]);assert.equal(info.duration,1.3);
  const plan=planFrames(info,{timestamps_seconds:[0,.15,.75,.85,1.1]});
  const frames=await extractFrames(samples.gif,info,plan,root,{maxSide:960});
  assert.deepEqual(frames.map(f=>f.time),[0,.1,.8,1]);
  const px=frames.map(f=>pixels(f.filename));
  assert.deepEqual([...px[0].subarray(0,4)],[255,0,0,255]);
  assert.deepEqual([...px[1].subarray(0,4)],[0,255,0,255]);
  assert.equal(px[2][3],0,'disposal 2 clears the left patch');
  assert.deepEqual([...px[2].subarray(12,16)],[0,0,255,255]);
  assert.deepEqual([...px[3].subarray(12,16)],[255,0,0,255],'disposal 3 restores the earlier red patch');
});
test('video exact times, range selection and long-held VFR frames',async()=>{
  const info=await probeMedia(samples.video);
  assert.equal(info.width,96);assert.equal(info.duration,3);
  let frames=await extractFrames(samples.video,info,planFrames(info,{timestamps_seconds:[0,1.25,2.95]}),root);
  assert.deepEqual(frames.map(f=>Number(f.time.toFixed(3))),[0,1.2,2.9]);
  const vfr=await probeMedia(samples.vfr);
  frames=await extractFrames(samples.vfr,vfr,planFrames(vfr,{timestamps_seconds:[5,10.8]}),root);
  assert.deepEqual(frames.map(f=>f.time),[2,10]);
  const offset=await probeMedia(samples.offset);
  frames=await extractFrames(samples.offset,offset,planFrames(offset,{timestamps_seconds:[0,1.25,2.95]}),root);
  assert.deepEqual(frames.map(f=>Number(f.time.toFixed(3))),[0,1.2,2.9],'timestamps are relative to the media start, not container PTS');
  assert.equal(planFrames(info,{start_seconds:1,end_seconds:2,frame_count:2}).frames[0].requested,1.25);
});
test('resource limits, malformed media, unsupported nested formats, cancellation',async()=>{
  const info=await probeMedia(samples.video);
  assert.equal(planFrames(info,{frame_count:24},undefined,3).frames.length,3);
  assert.throws(()=>planFrames(info,{timestamps_seconds:[3]}),/指定时间点/);
  assert.throws(()=>planFrames(info,{frame_count:25}),/数量/);
  assert.throws(()=>planFrames(info,{end_seconds:4}),/起止/);
  assert.throws(()=>planFrames(info,{timestamps_seconds:[0,1]},undefined,1),/数量/);
  assert.deepEqual(normalizeSettings({frameCount:-5,maxSide:999999}),{frameCount:12,maxSide:960});
  await fs.writeFile(path.join(root,'bad.mp4'),'not media');
  await assert.rejects(probeMedia(path.join(root,'bad.mp4')),/无法解码/);
  await fs.writeFile(path.join(root,'playlist.mp4'),'#EXTM3U\n#EXTINF:1\nhttp://127.0.0.1:1/secret.ts\n');
  await assert.rejects(probeMedia(path.join(root,'playlist.mp4')),/无法解码/);
  await assert.rejects(extractFrames(samples.video,info,planFrames(info,{frame_count:1}),root,{maxTotalBytes:1}),/总量/);
  const cancel=new AbortController();cancel.abort(new Error('canceled'));
  await assert.rejects(probeMedia(samples.video,{signal:cancel.signal}),/canceled/);
  await assert.rejects(runBinary(bin.ffmpeg,['-f','lavfi','-i','testsrc','-f','null','-'],{timeout:50}),/超时/);
});

test('model gate, session ownership, local filesystem policy, native image output and cleanup',async()=>{
  const ref={attachmentId:'sha256:'+'a'.repeat(64),name:'sample.mp4',bytes:(await fs.stat(samples.video)).size};
  const session={requestHeader:()=>({config:{provider:'test',model:'vision'}}),snapshotEvents:()=>[{type:'user/message',data:{content:[{type:'file',attachment:ref},{type:'image',attachment:{...ref,name:'normalized.gif'}}]}}]};
  assert.deepEqual(sessionFiles(session),[ref]);
  const saved=[];
  const ctx={llm:{resolveModelInfo:async()=>({inputModalities:['text','image']})},attachments:{imageLimits:{mediaTypes:['image/png'],maxImagesPerMessage:20,maxImageBytes:20e6,maxMessageImageBytes:200e6,maxImageDimension:8192,maxImagePixels:64e6},
    async *readFileStream(){yield await fs.readFile(samples.video)},async saveImage(input){saved.push(input);return {attachmentId:'sha256:'+String(saved.length).padStart(64,'0'),mediaType:'image/png',bytes:input.data.length,width:96,height:64,name:input.name}}},
    workingDirectory:{ensure:async()=>root},fs:{resolve:async()=>{throw new Error('policy denied')}},emit:()=>{}};
  const exec={agent:{session,options:{}},signal:signal()};
  await assertVision(ctx,exec.agent,exec.signal);
  const original=ctx.llm.resolveModelInfo;ctx.llm.resolveModelInfo=async()=>({inputModalities:['text']});
  await assert.rejects(assertVision(ctx,exec.agent,exec.signal),/看图能力/);ctx.llm.resolveModelInfo=original;
  await assert.rejects(copySource(ctx,{file_path:'C:/secret.mp4'},exec,path.join(root,'must-not-exist')),/policy denied/);
  await assert.rejects(copySource(ctx,{attachment_id:'foreign'},exec,path.join(root,'must-not-exist')),/当前会话/);
  const tempRoot=path.join(root,'jobs');
  const tool=createTool(ctx,async()=>({frameCount:3,maxSide:640}),new AbortController(),{tempRoot});
  const value=await tool.execute({attachment_name:ref.name},exec);
  assert.equal(value.frames.length,3);assert.equal(saved.length,3);assert.equal(renderResult({},value).filter(b=>b.type==='image').length,3);
  assert.deepEqual(await fs.readdir(tempRoot),[],'temporary original and frames are cleaned');
  const job=tool.execute({attachment_id:ref.attachmentId,frame_count:24},exec);
  await assert.rejects(tool.execute({attachment_id:ref.attachmentId},exec),/另一个/);await job;
  await assert.rejects(tool.execute({attachment_id:ref.attachmentId,timestamps_seconds:[30]},exec),/指定时间点/);
  assert.deepEqual(await fs.readdir(tempRoot),[]);
  const stopping=new AbortController();
  const canceledTool=createTool(ctx,async()=>({frameCount:24,maxSide:640}),stopping,{tempRoot});
  const canceled=canceledTool.execute({attachment_id:ref.attachmentId},exec);
  setTimeout(()=>stopping.abort(new Error('plugin unloaded')),100);
  await assert.rejects(canceled,/plugin unloaded/);
  assert.deepEqual(await fs.readdir(tempRoot),[],'unloading aborts subprocesses and cleans temporary copies');
});
