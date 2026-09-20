import { expect, test } from "@playwright/test";

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
