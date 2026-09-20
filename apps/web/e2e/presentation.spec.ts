import { expect, test } from "@playwright/test";

test("video negotiation supports a receive-only player and never sends audio",async({page})=>{
  await page.goto("/");
  const result=await page.evaluate(async()=>{
    const path="/src/game/video.ts";
    const {VideoLink}=await import(/* @vite-ignore */path);
    const canvas=document.createElement("canvas");canvas.width=320;canvas.height=180;
    const context=canvas.getContext("2d")!;context.fillStyle="#7655d3";context.fillRect(0,0,320,180);
    const stream=canvas.captureStream(10);
    const issues:string[]=[];const descriptions:string[]=[];
    let received:MediaStream|undefined;
    let left:InstanceType<typeof VideoLink>,right:InstanceType<typeof VideoLink>;
    left=new VideoLink((payload:Record<string,unknown>)=>{if(payload.description)descriptions.push(JSON.stringify(payload.description));queueMicrotask(()=>right.receive(payload,1));},()=>{},(s:string)=>issues.push(s));
    right=new VideoLink((payload:Record<string,unknown>)=>{if(payload.description)descriptions.push(JSON.stringify(payload.description));queueMicrotask(()=>left.receive(payload,1));},(s:MediaStream)=>{received=s;},(s:string)=>issues.push(s));
    right.start(new MediaStream(),true);left.start(stream,false);
    const deadline=performance.now()+5000;
    while(!received&&performance.now()<deadline)await new Promise(r=>setTimeout(r,20));
    const result={videos:received?.getVideoTracks().length??0,audios:received?.getAudioTracks().length??0,negotiatedAudio:descriptions.some(s=>s.includes("m=audio")),issues};
    left.stop();right.stop();stream.getTracks().forEach(t=>t.stop());return result;
  });
  expect(result.videos).toBe(1);expect(result.audios).toBe(0);expect(result.negotiatedAudio).toBe(false);expect(result.issues).toEqual([]);
});

test("a receive-only link can add a camera without a new signalling generation",async({page})=>{
  await page.goto("/");
  const result=await page.evaluate(async()=>{
    const path="/src/game/video.ts";
    const {VideoLink}=await import(/* @vite-ignore */path);
    const canvas=document.createElement("canvas");canvas.width=320;canvas.height=180;
    const context=canvas.getContext("2d")!;context.fillStyle="#7655d3";context.fillRect(0,0,320,180);
    const stream=canvas.captureStream(10);
    const issues:string[]=[];const descriptions:string[]=[];const generations:number[]=[];
    let received:MediaStream|undefined;
    let left:InstanceType<typeof VideoLink>,right:InstanceType<typeof VideoLink>;
    left=new VideoLink((payload:Record<string,unknown>)=>{if(payload.description)descriptions.push(JSON.stringify(payload.description));if(typeof payload.videoGeneration==="number")generations.push(payload.videoGeneration);queueMicrotask(()=>right.receive(payload,1));},(next:MediaStream)=>{received=next;},(issue:string)=>issues.push(issue));
    right=new VideoLink((payload:Record<string,unknown>)=>{if(payload.description)descriptions.push(JSON.stringify(payload.description));if(typeof payload.videoGeneration==="number")generations.push(payload.videoGeneration);queueMicrotask(()=>left.receive(payload,1));},()=>{},(issue:string)=>issues.push(issue));
    left.start(new MediaStream(),false);right.start(new MediaStream(),true);
    await new Promise(resolve=>setTimeout(resolve,300));
    await right.setLocalStream(stream);
    const deadline=performance.now()+5000;
    while(!received&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
    const outcome={videos:received?.getVideoTracks().length??0,audios:received?.getAudioTracks().length??0,generations:[...new Set(generations)],negotiatedAudio:descriptions.some(s=>s.includes("m=audio")),issues};
    left.stop();right.stop();stream.getTracks().forEach(track=>track.stop());return outcome;
  });
  expect(result.videos).toBe(1);expect(result.audios).toBe(0);expect(result.generations).toEqual([1]);expect(result.negotiatedAudio).toBe(false);expect(result.issues).toEqual([]);
});

test("a malformed future video generation cannot suppress valid negotiation",async({page})=>{
  await page.goto("/");
  const result=await page.evaluate(async()=>{
    const path="/src/game/video.ts";
    const {VideoLink}=await import(/* @vite-ignore */path);
    const canvas=document.createElement("canvas");canvas.width=320;canvas.height=180;
    const context=canvas.getContext("2d")!;context.fillStyle="#7655d3";context.fillRect(0,0,320,180);
    const stream=canvas.captureStream(10);
    const issues:string[]=[];const pending:Record<string,unknown>[]=[];let forward=false;let received:MediaStream|undefined;
    let left:InstanceType<typeof VideoLink>,right:InstanceType<typeof VideoLink>;
    left=new VideoLink((payload:Record<string,unknown>)=>{if(forward)queueMicrotask(()=>right.receive(payload,1));else pending.push(payload);},()=>{},(issue:string)=>issues.push(issue));
    right=new VideoLink((payload:Record<string,unknown>)=>queueMicrotask(()=>left.receive(payload,1)),(next:MediaStream)=>{received=next;},(issue:string)=>issues.push(issue));
    right.start(new MediaStream(),true);left.start(stream,false);
    right.receive({videoGeneration:99,description:{type:"offer",sdp:"m=audio 9 UDP/TLS/RTP/SAVPF 111"}},1);
    await new Promise(resolve=>setTimeout(resolve,80));
    forward=true;for(const payload of pending)right.receive(payload,1);
    const deadline=performance.now()+5000;
    while(!received&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
    const outcome={videos:received?.getVideoTracks().length??0,issues};
    left.stop();right.stop();stream.getTracks().forEach(track=>track.stop());return outcome;
  });
  expect(result.videos).toBe(1);expect(result.issues).toEqual(["Camera connection unavailable"]);
});

test("signals queued before stop cannot enter the replacement peer",async({page})=>{
  await page.goto("/");
  const issues=await page.evaluate(async()=>{
    const path="/src/game/video.ts";
    const {VideoLink}=await import(/* @vite-ignore */path);
    const failures:string[]=[];
    const link=new VideoLink(()=>{},()=>{},(issue:string)=>failures.push(issue));
    link.start(new MediaStream(),true);
    link.receive({videoGeneration:1,description:{type:"offer",sdp:"m=audio 9 UDP/TLS/RTP/SAVPF 111"}},1);
    link.stop();
    link.start(new MediaStream(),true);
    await new Promise(resolve=>setTimeout(resolve,50));
    link.stop();
    return failures;
  });
  expect(issues).toEqual([]);
});

test("pooled spell renderer keeps stable resources through 100 cast cycles",async({page})=>{
  await page.goto("/");
  const result=await page.evaluate(async()=>{
    const effectsPath="/src/game/effects.ts";
    const {DuelEffects}=await import(/* @vite-ignore */effectsPath);
    const canvas=document.createElement("canvas");canvas.style.cssText="width:800px;height:500px;position:fixed;inset:0";document.body.append(canvas);
    let now=1000;const effects=new DuelEffects(canvas,()=>now);
    const player=(slot:string)=>({slot,name:slot,source:"ble",connected:true,ready:true,inputHealthy:true,inputGeneration:1,deviceId:"x",bootId:1,hp:100,maxHp:100,shieldUntilMs:0,offenseLockedUntilMs:0,cooldownUntilMs:{stupefy:0,protego:0,expelliarmus:0,incendio:0,episkey:0}});
    const snapshot:any={roomId:"main",roomGeneration:1,roundId:1,stateVersion:1,serverNowMs:now,phase:"playing",countdownEndsAtMs:null,roundEndsAtMs:61000,result:null,players:{P1:player("P1"),P2:player("P2")},projectiles:[],recentEvents:[]};
    effects.update(snapshot,"P1");await new Promise(requestAnimationFrame);const before=effects.resourceCounts();
    for(let n=0;n<100;n++){
      now=1000+n*40;snapshot.stateVersion++;snapshot.projectiles=[{id:`p${n}`,actionId:`a${n}`,spell:"stupefy",caster:"P1",target:"P2",launchAtMs:now-500,impactAtMs:now+1500,damage:20,offenseLockMs:0}];snapshot.players.P1.shieldUntilMs=now+1200;
      snapshot.recentEvents=[{id:`e${n}`,type:"impactBlocked",atMs:now,roundId:1,stateVersion:snapshot.stateVersion,target:"P1"}];effects.update(snapshot,"P1");await new Promise(requestAnimationFrame);
    }
    const after=effects.resourceCounts();effects.update(undefined);await new Promise(requestAnimationFrame);const cleared=effects.resourceCounts();effects.dispose();canvas.remove();return {before,after,cleared};
  });
  expect(result.after.geometries).toBe(result.before.geometries);expect(result.after.textures).toBe(result.before.textures);expect(result.after.drawCalls).toBeLessThanOrEqual(20);expect(result.cleared.drawCalls).toBe(0);
});
