import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ============================================================
   Utilities
   ============================================================ */
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
const rnd = mulberry32(20261104);
const R  = (a,b)=>a+(b-a)*rnd();             // deterministic (layout)
const Rr = (a,b)=>a+(b-a)*Math.random();     // runtime
const pick = a => a[Math.floor(Math.random()*a.length)];
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const lerp=(a,b,t)=>a+(b-a)*t;
const smooth=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t)};
const hex = c => '#'+new THREE.Color(c).getHexString();
const V = (x,y,z)=>new THREE.Vector3(x,y,z);
const hash = s => { let h=2166136261; for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);} return h>>>0; };
const timeOf = ms => { const d=new Date(ms); return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
const ago = ms => { if(!ms) return '—'; const s=Math.max(0,(Date.now()-ms)/1000); if(s<60) return Math.floor(s)+' giây trước'; if(s<3600) return Math.floor(s/60)+' phút trước'; if(s<86400) return Math.floor(s/3600)+' giờ trước'; return Math.floor(s/86400)+' ngày trước'; };
const esc = s => String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* ============================================================
   Live data (Paperclip API via local read-only proxy)
   ============================================================ */
const DATA = {agents:[], issues:[], runs:[], allRuns:null, activity:[], projects:[], dash:null, goal:null, company:null, ok:false, at:0};
let projFilter=null;   // selected project id (null = all projects)
const curIssues = () => projFilter ? DATA.issues.filter(i=>i.projectId===projFilter) : DATA.issues;
const PCOL=[0x5be7ff,0xff5fa2,0x4ade80,0xffc24b,0xb36bff,0xff7a59,0x4f9dff,0x9be564];
const projColor = p => { const i=DATA.projects.findIndex(x=>x.id===(p&&p.id||p)); return PCOL[(i<0?0:i)%PCOL.length]; };
const projectOf = i => DATA.projects.find(p=>p.id===i.projectId);
const FEED = [];            // formatted activity lines for the café screen
const isOpen = i => !['done','cancelled'].includes(i.status);
const agentById = id => DATA.agents.find(a=>a.id===id);
const issueById = id => DATA.issues.find(i=>i.id===id);

async function jget(p){ const r=await fetch('/api'+p,{cache:'no-store'}); if(!r.ok) throw new Error(r.status); return r.json(); }
let companyId=null;
// Two polling tiers. The full run history is ~2 MB and takes ~1 s server-side, so live mode only
// fetches the newest runs (newest first); "who is running" also falls back to agent.status.
// The full history is loaded on demand for replay (loadAllRuns).
const LIVE_RUNS=40, SLOW_MS=15000;
let slowAt=0;
const companyPath=()=>'/companies/'+companyId;
async function pollOnce(){
  try{
    if(!companyId){ const cs=await jget('/companies'); DATA.company=cs[0]; companyId=cs[0]&&cs[0].id; }
    const B=companyPath();
    const [agents,runs]=await Promise.all([jget(B+'/agents'),jget(B+'/heartbeat-runs?limit='+LIVE_RUNS)]);
    Object.assign(DATA,{agents,runs,ok:true,at:Date.now()});
    if(Date.now()-slowAt>SLOW_MS){
      const [issues,activity,dash,projects]=await Promise.all([jget(B+'/issues'),jget(B+'/activity'),jget(B+'/dashboard'),jget(B+'/projects').catch(()=>DATA.projects)]);
      Object.assign(DATA,{issues,activity,dash,projects:(projects||[]).filter(p=>!p.archivedAt)});
      slowAt=Date.now();
    }
    if(!DATA.goal){ try{ const g=await jget(B+'/goals'); DATA.goal=g[0]||null; }catch(e){} }
  }catch(e){ DATA.ok=false; }
  return DATA.ok;
}
async function loadAllRuns(){ DATA.allRuns=await jget(companyPath()+'/heartbeat-runs'); return DATA.allRuns; }
await pollOnce();

/* ============================================================
   Company layout — departments mirror the real org chart
   ============================================================ */
const ZONES = [
  // back row  (z -18 .. -2)
  {id:'exec',  name:'Ban điều hành',   en:'Executive',   color:0xffc24b, x0:-30,x1:-21,row:'back',  min:2, kind:'office',  screen:'exec'},
  {id:'eng',   name:'Kỹ thuật',        en:'Engineering', color:0x4f9dff, x0:-21,x1:0,  row:'back',  min:8, kind:'office',  screen:'code'},
  {id:'ops',   name:'DevOps',          en:'Infra',       color:0xb36bff, x0:0,  x1:9,  row:'back',  min:2, kind:'office',  screen:'runs', racks:true},
  {id:'qa',    name:'Kiểm thử (QA)',   en:'Quality',     color:0x35d0a0, x0:9,  x1:21, row:'back',  min:4, kind:'office',  screen:'issuegrid'},
  {id:'meet',  name:'Phòng họp',       en:'Meeting',     color:0xff7a59, x0:21, x1:30, row:'back',  min:0, kind:'meeting', screen:'agenda'},
  // front row (z 2 .. 18)
  {id:'lobby', name:'Sảnh lễ tân',     en:'Lobby',       color:0x8fa8c8, x0:-30,x1:-22,row:'front', min:0, kind:'office',  screen:'welcome', lobby:true},
  {id:'prod',  name:'Sản phẩm',        en:'Product',     color:0xff5fa2, x0:-22,x1:-9, row:'front', min:4, kind:'office',  screen:'kanban'},
  {id:'design',name:'Thiết kế',        en:'Design',      color:0xff8a3d, x0:-9, x1:0,  row:'front', min:2, kind:'office',  screen:'palette'},
  {id:'mkt',   name:'Marketing',       en:'Marketing',   color:0x5be7ff, x0:0,  x1:13, row:'front', min:5, kind:'office',  screen:'budget'},
  {id:'lounge',name:'Khu nghỉ',        en:'Lounge',      color:0x9be564, x0:13, x1:21, row:'front', min:0, kind:'lounge',  screen:'idle'},
  {id:'cafe',  name:'Cafeteria',       en:'Cafe',        color:0xffb86b, x0:21, x1:30, row:'front', min:0, kind:'cafe',    screen:'feed'},
];
const ZB = Object.fromEntries(ZONES.map(z=>[z.id,z]));
ZONES.forEach(z=>{
  z.s  = z.row==='back' ? -1 : 1;
  z.z0 = z.row==='back' ? -18 : 2;
  z.z1 = z.row==='back' ? -2  : 18;
  z.w  = z.x1-z.x0; z.d = z.z1-z.z0;
  z.cx = (z.x0+z.x1)/2; z.cz=(z.z0+z.z1)/2;
  z.doorX = z.kind==='office' ? z.cx : z.x0+1.4;
  z.doorIn = V(z.doorX,0,z.s*2.9);
  z.seats=[]; z.bar=[]; z.people=[]; z.deskSpots=[];
  z.col = new THREE.Color(z.color);
});

// real agent → department (role/title come from Paperclip)
function zoneOf(a){
  const role=(a.role||'').toLowerCase(), title=(a.title||'').toLowerCase();
  // the org chart's own department wins over role heuristics (e.g. Video Producer has role "designer" but sits in Marketing)
  const dept=((a.metadata&&a.metadata.department)||'').toLowerCase();
  if(dept==='marketing') return 'mkt';
  if(dept==='qa') return 'qa';
  if(role==='ceo') return 'exec';
  if(role==='devops' || /devops|release|sre/.test(title)) return 'ops';
  if(role==='qa' || /\bqa\b|tester/.test(title)) return 'qa';
  if(role==='designer' || /design/.test(title)) return 'design';
  if(role==='cmo' || /market|growth|social|content|seo/.test(title)) return 'mkt';
  if(role==='pm' || role==='cpo' || /product|business analyst|project manager/.test(title)) return 'prod';
  if(role==='cto' || role==='engineer' || /engineer|tech lead|developer/.test(title)) return 'eng';
  return 'exec';
}
const countByZone = {};
for(const a of DATA.agents) countByZone[zoneOf(a)]=(countByZone[zoneOf(a)]||0)+1;

/* ============================================================
   Renderer / scene
   ============================================================ */
const stage = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({antialias:false, powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.setSize(innerWidth,innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
stage.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer({element: document.getElementById('labels')});
labelRenderer.setSize(innerWidth,innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9ec9f0);
scene.fog = new THREE.Fog(0x9ec9f0, 170, 430);

const camera = new THREE.PerspectiveCamera(38, innerWidth/innerHeight, 0.1, 600);
camera.position.set(0,46,62);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = .06;
controls.maxPolarAngle = Math.PI/2 - .03; controls.minDistance = 6; controls.maxDistance = 150;
controls.target.set(0,0,0);
controls.autoRotateSpeed = .6;

const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(innerWidth*renderer.getPixelRatio(), innerHeight*renderer.getPixelRatio(), {type:THREE.HalfFloatType, samples:4}));
composer.addPass(new RenderPass(scene,camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth,innerHeight), .55, .65, .92);
composer.addPass(bloom);
composer.addPass(new OutputPass());

/* lights */
const hemi = new THREE.HemisphereLight(0xcfe6ff, 0x20283c, .9); scene.add(hemi);
const sun  = new THREE.DirectionalLight(0xfff1d6, 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048,2048);
const sc = sun.shadow.camera; sc.left=-42; sc.right=42; sc.top=28; sc.bottom=-28; sc.near=1; sc.far=160;
sun.shadow.bias=-.0004; sun.shadow.normalBias=.04;
scene.add(sun, sun.target);

/* ============================================================
   Materials & shared geometry
   ============================================================ */
function tileTexture(){
  const c=document.createElement('canvas'); c.width=c.height=128; const x=c.getContext('2d');
  x.fillStyle='#fff'; x.fillRect(0,0,128,128);
  x.strokeStyle='rgba(0,0,0,.18)'; x.lineWidth=2; x.strokeRect(0,0,128,128);
  const t=new THREE.CanvasTexture(c); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.colorSpace=THREE.SRGBColorSpace; t.anisotropy=4; return t;
}
const tileTex = tileTexture();
const M = {
  slab:   new THREE.MeshStandardMaterial({color:0x10172a, roughness:.7, metalness:.2}),
  corr:   new THREE.MeshStandardMaterial({color:0x7c88a6, roughness:.35, metalness:.25, map:tileTex}),
  glass:  new THREE.MeshPhysicalMaterial({color:0xaee4ff, transparent:true, opacity:.14, roughness:.05, metalness:0, depthWrite:false, side:THREE.DoubleSide}),
  rail:   new THREE.MeshStandardMaterial({color:0x1b2238, roughness:.5, metalness:.6}),
  desk:   new THREE.MeshStandardMaterial({color:0xe8e2d6, roughness:.55, metalness:.05}),
  deskLeg:new THREE.MeshStandardMaterial({color:0x2b3350, roughness:.4, metalness:.6}),
  black:  new THREE.MeshStandardMaterial({color:0x14171f, roughness:.5, metalness:.3}),
  chair:  new THREE.MeshStandardMaterial({color:0x252b3f, roughness:.8}),
  white:  new THREE.MeshStandardMaterial({color:0xf4f6fb, roughness:.6}),
  wood:   new THREE.MeshStandardMaterial({color:0xb98b5e, roughness:.6}),
  skin:   [0xf1c9a5,0xe0ac82,0xc68863,0x8d5a3a].map(c=>new THREE.MeshStandardMaterial({color:c, roughness:.7})),
  hair:   [0x1a1410,0x2c1d12,0x5a3a1f,0x0d0d10,0x6b4a2b].map(c=>new THREE.MeshStandardMaterial({color:c, roughness:.8})),
  pants:  [0x1d2540,0x2b2f3a,0x37465f,0x222222].map(c=>new THREE.MeshStandardMaterial({color:c, roughness:.8})),
  leaf:   new THREE.MeshStandardMaterial({color:0x2f9d57, roughness:.8}),
  pot:    new THREE.MeshStandardMaterial({color:0xe9eef7, roughness:.5}),
  rack:   new THREE.MeshStandardMaterial({color:0x0e1220, roughness:.4, metalness:.7}),
  fabric: new THREE.MeshStandardMaterial({color:0x2d3a63, roughness:.95}),
};
const G = {
  box: new THREE.BoxGeometry(1,1,1),
  cyl: new THREE.CylinderGeometry(1,1,1,20),
  sph: new THREE.SphereGeometry(1,20,14),
  cap: new THREE.CapsuleGeometry(.17,.36,6,12),
};
function mesh(geo, mat, sx,sy,sz, x,y,z, parent, shadow=true){
  const m=new THREE.Mesh(geo,mat); m.scale.set(sx,sy,sz); m.position.set(x,y,z);
  if(shadow){m.castShadow=true; m.receiveShadow=true;} else m.receiveShadow=true;
  parent&&parent.add(m); return m;
}
const box=(sx,sy,sz,mat,x,y,z,p,sh=true)=>mesh(G.box,mat,sx,sy,sz,x,y,z,p,sh);

const world = new THREE.Group(); scene.add(world);

/* ============================================================
   Environment: slab, ground, city, particles
   ============================================================ */
// building slab
box(61.6,.5,37.6,M.slab,0,-.25,0,world,false);
// corridor floor
{
  const t=tileTex.clone(); t.repeat.set(30,2); t.needsUpdate=true;
  const m=M.corr.clone(); m.map=t;
  const f=new THREE.Mesh(new THREE.PlaneGeometry(60,4),m); f.rotation.x=-Math.PI/2; f.position.y=.005; f.receiveShadow=true; world.add(f);
  // guide light strips
  for(const z of [-1.85,1.85]){
    const s=new THREE.Mesh(new THREE.PlaneGeometry(60,.08), new THREE.MeshBasicMaterial({color:0x7fe9ff, toneMapped:false}));
    s.rotation.x=-Math.PI/2; s.position.set(0,.012,z); world.add(s);
  }
}
// ground
{
  const g=new THREE.Mesh(new THREE.CircleGeometry(400,64), new THREE.MeshStandardMaterial({color:0x2a3142, roughness:1}));
  g.rotation.x=-Math.PI/2; g.position.y=-.52; g.receiveShadow=true; scene.add(g);
  const grid=new THREE.GridHelper(300,100,0x5be7ff,0x5be7ff); grid.position.y=-.5; grid.material.transparent=true; grid.material.opacity=.07; scene.add(grid);
}
// city skyline
const cityMats=[];
{
  const wc=document.createElement('canvas'); wc.width=wc.height=128; const x=wc.getContext('2d');
  x.fillStyle='#000'; x.fillRect(0,0,128,128);
  for(let i=0;i<8;i++)for(let j=0;j<8;j++){ if(rnd()<.55){ x.fillStyle=rnd()<.8?'#ffd9a0':'#9fd8ff'; x.fillRect(i*16+3,j*16+4,9,8);} }
  const wt=new THREE.CanvasTexture(wc); wt.wrapS=wt.wrapT=THREE.RepeatWrapping; wt.colorSpace=THREE.SRGBColorSpace; wt.magFilter=THREE.NearestFilter;
  for(let i=0;i<46;i++){
    const ang=rnd()*Math.PI*2, rad=62+rnd()*90;
    const w=R(5,13), h=R(10,48), d=R(5,13);
    const geo=new THREE.BoxGeometry(w,h,d);
    const uv=geo.attributes.uv; for(let k=0;k<uv.count;k++) uv.setXY(k, uv.getX(k)*w/9, uv.getY(k)*h/9);
    const mat=new THREE.MeshStandardMaterial({color:new THREE.Color().setHSL(.6,.25,.16+rnd()*.1), roughness:.7, metalness:.2, emissive:0xffffff, emissiveMap:wt, emissiveIntensity:0});
    cityMats.push(mat);
    const b=new THREE.Mesh(geo,mat); b.position.set(Math.cos(ang)*rad*1.25, h/2-.5, Math.sin(ang)*rad); b.castShadow=false; scene.add(b);
  }
}
// dust motes
const motes = (()=>{
  const n=260, pos=new Float32Array(n*3), sp=[];
  for(let i=0;i<n;i++){pos[i*3]=R(-30,30);pos[i*3+1]=R(.5,5);pos[i*3+2]=R(-18,18);sp.push(R(.05,.2));}
  const g=new THREE.BufferGeometry(); g.setAttribute('position',new THREE.BufferAttribute(pos,3));
  const p=new THREE.Points(g,new THREE.PointsMaterial({color:0xbfeaff,size:.07,transparent:true,opacity:.55,depthWrite:false,sizeAttenuation:true}));
  scene.add(p); return {p,pos,sp};
})();

/* ============================================================
   Wall screens (canvas textures)
   ============================================================ */
const screens=[];
function makeScreen(zone, w, h, x, y, z, flipFront){
  const c=document.createElement('canvas'); c.width=640; c.height=320; const ctx=c.getContext('2d');
  const tex=new THREE.CanvasTexture(c); tex.colorSpace=THREE.SRGBColorSpace; tex.anisotropy=4;
  const mat=new THREE.MeshBasicMaterial({map:tex, toneMapped:false});
  const m=new THREE.Mesh(new THREE.PlaneGeometry(w,h),mat); m.position.set(x,y,z); world.add(m);
  // bezel
  box(w+.16,h+.16,.06,M.black,x,y,z-.04,world,false);
  const scr={zone,ctx,tex,w:640,h:320,seed:rnd()*100,draw:DRAW[zone.screen]};
  screens.push(scr); scr.draw(scr,0); tex.needsUpdate=true;
  return scr;
}
function hdr(s, title, sub){
  const {ctx,w}=s, col=hex(s.zone.color);
  ctx.fillStyle='#0a0f1e'; ctx.fillRect(0,0,w,320);
  ctx.fillStyle=col; ctx.fillRect(0,0,w,6);
  ctx.fillStyle='#fff'; ctx.font='700 26px Inter, sans-serif'; ctx.fillText(title,22,44);
  ctx.fillStyle='#8d9bbd'; ctx.font='500 15px Inter, sans-serif'; ctx.fillText(sub,22,66);
}
const ISS_COL={done:'#4ade80',blocked:'#ff7a59',cancelled:'#4a5470',todo:'#5be7ff',in_progress:'#ffc24b',in_review:'#b36bff',backlog:'#8d9bbd'};
const issCol=s=>ISS_COL[s]||'#8d9bbd';
const MODEv={};   // agentId -> mode key (read by wall screens)
function clip(ctx,text,maxw){ text=String(text??''); if(ctx.measureText(text).width<=maxw) return text; while(text.length>1&&ctx.measureText(text+'…').width>maxw) text=text.slice(0,-1); return text+'…'; }
function wrap(ctx,text,x,y,maxw,font,color,lh,maxLines){ ctx.font=font; ctx.fillStyle=color; const words=String(text).split(' '); let line='',n=0;
  for(const w of words){ const t=line?line+' '+w:w; if(ctx.measureText(t).width>maxw&&line){ ctx.fillText(line,x,y+n*lh); line=w; if(++n>=maxLines) return; } else line=t; }
  if(line) ctx.fillText(line,x,y+n*lh); }
const DRAW = {
  exec(s,t){ const c=DATA.company; hdr(s,(c&&c.name)||'Công ty','Mục tiêu hiện tại'); const {ctx}=s;
    wrap(ctx,(DATA.goal&&DATA.goal.title)||'Chưa kết nối Paperclip',22,104,596,'700 21px Inter, sans-serif','#e8eefc',27,3);
    const d=DATA.dash; if(d){ const kv=[['Agent hoạt động',d.agents.active],['Đang chạy',d.agents.running],['Issue mở',d.tasks.open],['Bị chặn',d.tasks.blocked],['Hoàn thành',d.tasks.done]];
      kv.forEach(([k,v],i)=>{ ctx.fillStyle='#161d36'; ctx.fillRect(22+i*118,214,110,72); ctx.fillStyle='#fff'; ctx.font='800 28px Inter'; ctx.fillText(v,34+i*118,252); ctx.fillStyle='#8d9bbd'; ctx.font='11px Inter'; ctx.fillText(k,34+i*118,274); }); } },
  code(s,t){ const n=curIssues().filter(i=>isOpen(i)&&zoneOf(agentById(i.assigneeAgentId)||{})==='eng').length;
    hdr(s,'Engineering · '+(projFilter?((DATA.projects.find(p=>p.id===projFilter)||{}).name||''):'mọi dự án'),n+' issue mở · '+DATA.agents.filter(a=>zoneOf(a)==='eng').length+' kỹ sư'); const {ctx}=s;
    const toks=['#ff7ab2','#7ee787','#79c0ff','#d2a8ff','#ffa657','#8b949e'];
    ctx.font='15px ui-monospace, Menlo, monospace';
    for(let i=0;i<10;i++){ const y=96+i*21; const ln=Math.floor(t*2)+i; let x=22+((ln*7)%4)*18;
      const r=mulberry32(ln*97+3);
      ctx.fillStyle='#4a5470'; ctx.fillText(String(ln%999).padStart(3,'0'),0,y);
      const n=2+Math.floor(r()*4);
      for(let k=0;k<n;k++){ const wd=20+Math.floor(r()*70); ctx.fillStyle=toks[Math.floor(r()*toks.length)]; ctx.fillRect(x+30,y-11,wd,12); x+=wd+8; } } },
  runs(s,t){ hdr(s,'DevOps · Lượt chạy agent','14 ngày gần nhất'); const {ctx}=s; const ra=((DATA.dash&&DATA.dash.runActivity)||[]).slice(-14);
    const mx=Math.max(3,...ra.map(r=>r.total)); ra.forEach((r,i)=>{ const x=30+i*42, bh=180/mx; let y=290;
      [['#4ade80',r.succeeded],['#ff5d73',r.failed],['#ffc24b',r.recovered+r.other]].forEach(([c,v])=>{ if(v){ ctx.fillStyle=c; ctx.fillRect(x,y-v*bh,32,v*bh-1); y-=v*bh; } });
      ctx.fillStyle='#4a5470'; ctx.font='10px Inter'; ctx.fillText(String(r.date).slice(8),x+8,306); });
    ctx.fillStyle='#8d9bbd'; ctx.font='13px Inter'; ctx.fillText('■ thành công  ■ lỗi  ■ khác',22,92); },
  issuegrid(s,t){ hdr(s,'QA · Trạng thái issue',curIssues().length+' issue · '+(projFilter?'1 dự án':DATA.projects.length+' dự án')); const {ctx}=s;
    curIssues().slice().sort((a,b)=>String(a.identifier).localeCompare(String(b.identifier),undefined,{numeric:true})).forEach((is,i)=>{ const x=22+(i%9)*66, y=92+Math.floor(i/9)*62; ctx.fillStyle=issCol(is.status); ctx.globalAlpha=is.status==='cancelled'?.35:.9; ctx.fillRect(x,y,58,52); ctx.globalAlpha=1;
      ctx.fillStyle='#05101a'; ctx.font='700 13px Inter'; ctx.fillText(is.identifier||'',x+6,y+22); ctx.font='10px Inter'; ctx.fillText(is.status,x+6,y+40); }); },
  agenda(s,t){ hdr(s,'Bảng issue đang mở','Ưu tiên: bị chặn → đang làm'); const {ctx}=s;
    const rank={blocked:0,in_progress:1,in_review:2,todo:3,backlog:4}; const list=curIssues().filter(isOpen).sort((a,b)=>(rank[a.status]??9)-(rank[b.status]??9)).slice(0,5);
    if(!list.length){ ctx.fillStyle='#8d9bbd'; ctx.font='18px Inter'; ctx.fillText('Không có issue mở 🎉',24,130); }
    list.forEach((is,i)=>{ const y=100+i*44; ctx.fillStyle='#161d36'; ctx.fillRect(22,y-22,596,38); ctx.fillStyle=issCol(is.status); ctx.fillRect(22,y-22,5,38);
      const ag=agentById(is.assigneeAgentId); ctx.fillStyle='#fff'; ctx.font='700 14px Inter'; ctx.fillText(is.identifier,36,y); ctx.font='13px Inter'; ctx.fillStyle='#cdd7f2'; ctx.fillText(clip(ctx,is.title,380),96,y);
      ctx.fillStyle='#8d9bbd'; ctx.font='11px Inter'; ctx.fillText(ag?clip(ctx,ag.name,90):'—',520,y); }); },
  welcome(s,t){ const c=DATA.company; hdr(s,'Chào mừng đến',DATA.projects.length+' dự án đang vận hành'); const {ctx}=s;
    ctx.fillStyle='#4ade80'; ctx.beginPath(); ctx.arc(110,200,50+4*Math.sin(t*2),0,7); ctx.fill();
    ctx.fillStyle='#fff'; ctx.font='800 30px Inter'; ctx.fillText(clip(ctx,(c&&c.name)||'QLDA Agent Co.',380),190,196); ctx.font='15px Inter'; ctx.fillStyle='#8d9bbd'; DATA.projects.slice(0,4).forEach((p,i)=>{ ctx.fillStyle=hex(projColor(p)); ctx.fillText('■ '+clip(ctx,p.name,330),192,228+i*22); }); },
  kanban(s,t){ hdr(s,'Product · Bảng issue','Theo trạng thái'); const {ctx}=s; const cols=[['Mở',i=>['todo','backlog','in_progress','in_review'].includes(i.status),'#5be7ff'],['Bị chặn',i=>i.status==='blocked','#ff7a59'],['Xong',i=>i.status==='done','#4ade80'],['Huỷ',i=>i.status==='cancelled','#8d9bbd']];
    cols.forEach(([n,f,c],i)=>{ const L=curIssues().filter(f); ctx.fillStyle=c; ctx.font='700 14px Inter'; ctx.fillText(n+' · '+L.length,24+i*152,98);
      L.slice(0,4).forEach((is,k)=>{ ctx.fillStyle='#1a2140'; ctx.fillRect(22+i*152,110+k*50,138,40); ctx.fillStyle=c; ctx.fillRect(22+i*152,110+k*50,4,40); ctx.fillStyle='#e8eefc'; ctx.font='700 12px Inter'; ctx.fillText(is.identifier||'',34+i*152,127+k*50); ctx.fillStyle='#8d9bbd'; ctx.font='10px Inter'; ctx.fillText(clip(ctx,(is.title||'').replace(/^\[[^\]]+\]\s*/,''),112),34+i*152,141+k*50); }); }); },
  palette(s,t){ hdr(s,'Design · UI/UX','Tokens · Components'); const {ctx}=s; const pal=['#4ade80','#5be7ff','#ffc24b','#ff7a59','#b36bff','#ff5fa2','#4f9dff','#e8eefc'];
    pal.forEach((c,i)=>{ ctx.fillStyle=c; ctx.beginPath(); ctx.arc(60+i*72,150+8*Math.sin(t*2+i),26,0,7); ctx.fill(); });
    ctx.fillStyle='#1a2140'; ctx.fillRect(22,220,596,70); ctx.fillStyle='#4ade80'; ctx.fillRect(40,238,150,34); ctx.fillStyle='#fff'; ctx.font='700 16px Inter'; ctx.fillText('Thêm bữa ăn',60,260); },
  budget(s,t){ const d=DATA.dash&&DATA.dash.costs; hdr(s,'Marketing · Ngân sách agent','Chi phí tháng này'); const {ctx}=s; const sp=d?d.monthSpendCents/100:0, bu=d?d.monthBudgetCents/100:0;
    ctx.fillStyle='#fff'; ctx.font='800 40px Inter'; ctx.fillText('$'+sp.toFixed(2),24,140); ctx.fillStyle='#8d9bbd'; ctx.font='16px Inter'; ctx.fillText('/ $'+bu.toFixed(0)+' ngân sách',24,166);
    ctx.fillStyle='#161d36'; ctx.fillRect(24,186,592,22); ctx.fillStyle='#5be7ff'; ctx.fillRect(24,186,592*clamp(bu?sp/bu:0,0,1),22);
    const top=DATA.agents.slice().sort((a,b)=>(b.spentMonthlyCents||0)-(a.spentMonthlyCents||0)).slice(0,3); ctx.font='13px Inter';
    top.forEach((a,i)=>{ ctx.fillStyle='#cdd7f2'; ctx.fillText(clip(ctx,a.name,200)+'  ·  $'+((a.spentMonthlyCents||0)/100).toFixed(2),24,242+i*24); }); },
  idle(s,t){ const L=DATA.agents.filter(a=>MODEv[a.id] && MODEv[a.id]!=='running' && MODEv[a.id]!=='queued'); hdr(s,'Khu nghỉ',L.length+' agent đang nghỉ · '+(DATA.agents.length-L.length)+' đang làm'); const {ctx}=s; ctx.font='15px Inter';
    L.slice(0,10).forEach((a,i)=>{ ctx.fillStyle='#9be564'; ctx.fillText(MODE[MODEv[a.id]].i+' ',24+(i%2)*300,104+Math.floor(i/2)*38); ctx.fillStyle='#cdd7f2'; ctx.fillText(clip(ctx,a.name,240),52+(i%2)*300,104+Math.floor(i/2)*38); }); },
  feed(s,t){ hdr(s,'Cafeteria · Bảng tin','Hoạt động mới nhất'); const {ctx}=s; ctx.font='14px Inter';
    FEED.slice(0,7).forEach((f,i)=>{ ctx.fillStyle='#ffb86b'; ctx.fillText(f.time,24,100+i*30); ctx.fillStyle=i?'#cdd7f2':'#fff'; ctx.fillText(clip(ctx,f.plain,500),84,100+i*30); }); },
};

/* ============================================================
   Build zones
   ============================================================ */
const labelsCSS = [];
const hoverTargets = []; // floor meshes
const ledInst = [];       // server LED instanced meshes
const zoneLights = [];

function plant(x,z,p,sc=1){
  box(.34*sc,.34*sc,.34*sc,M.pot,x,.17*sc,z,p);
  for(let i=0;i<4;i++) mesh(G.sph,M.leaf,.22*sc,.3*sc,.22*sc,x+R(-.12,.12)*sc,.5*sc+i*.12*sc,z+R(-.12,.12)*sc,p);
}

function buildWalls(z){
  const col=z.col;
  const neon = new THREE.MeshBasicMaterial({color:col.clone().multiplyScalar(1.6), toneMapped:false});
  const H=3.0;
  function wall(x,zz,len,axis){ // axis 'x' => runs along x ; 'z' => along z
    const g=new THREE.Group(); g.position.set(x,0,zz);
    const lx = axis==='x'?len:.08, lz = axis==='x'?.08:len;
    box(lx,H-.35,lz,M.glass,0,.35+(H-.35)/2,0,g,false);
    box(axis==='x'?len:.14,.35,axis==='x'?.14:len,M.rail,0,.175,0,g);
    box(axis==='x'?len:.1,.07,axis==='x'?.1:len,neon,0,H,0,g,false);
    world.add(g);
  }
  // far wall
  wall(z.cx, z.s*18, z.w, 'x');
  // corridor wall with door gap
  const ez=z.s*2, gap=2.0, dx=z.doorX;
  const lenL=(dx-gap/2)-z.x0, lenR=z.x1-(dx+gap/2);
  if(lenL>0) wall(z.x0+lenL/2, ez, lenL, 'x');
  if(lenR>0) wall(z.x1-lenR/2, ez, lenR, 'x');
  // door frame
  box(.12,H,.12,neon,dx-gap/2,H/2,ez,world,false); box(.12,H,.12,neon,dx+gap/2,H/2,ez,world,false); box(gap+.12,.1,.12,neon,dx,H,ez,world,false);
  // side walls
  wall(z.x0, z.cz, z.d, 'z');
  if(z.x1===30) wall(30, z.cz, z.d, 'z');
  // lobby entrance gap: replace far wall of lobby w/ door -> glass anyway (agents walk "through" a door frame)
  if(z.lobby){ box(.12,H,.12,neon,z.doorX-1.2,H/2,18,world,false); box(.12,H,.12,neon,z.doorX+1.2,H/2,18,world,false); box(2.52,.1,.12,neon,z.doorX,H,18,world,false); }
}

function buildDesk(z, x, dz, spots){
  const g=new THREE.Group(); g.position.set(x,0,dz); world.add(g);
  box(1.8,.06,.8,M.desk,0,.75,0,g);
  box(.05,.72,.7,M.deskLeg,-.85,.36,0,g); box(.05,.72,.7,M.deskLeg,.85,.36,0,g);
  box(1.7,.35,.04,M.deskLeg,0,.5,-.3,g);
  // monitor(s)
  const dual = z.id==='eng' || z.id==='design';
  // per-desk screen: lit only while its owner is seated and running (see frame loop)
  const mm = new THREE.MeshBasicMaterial({color:0x05080f, toneMapped:false});
  const mons = dual?[-.32,.32]:[0];
  for(const mx of mons){
    box(.05,.22,.05,M.black,mx,.88,-.18,g);
    box(.12,.02,.12,M.black,mx,.78,-.18,g,false);
    box(dual?.55:.7,dual?.34:.4,.03,M.black,mx,1.08,-.2,g);
    const scr=new THREE.Mesh(G.box,mm); scr.scale.set((dual?.5:.64),(dual?.29:.34),.01); scr.position.set(mx,1.08,-.18); g.add(scr);
  }
  box(.46,.015,.15,M.black,0,.785,.14,g,false);
  box(.07,.02,.1,M.black,.4,.785,.14,g,false);
  const r=rnd();
  if(r<.4) { mesh(G.cyl,M.white,.04,.05,.04,-.7,.81,.1,g); }          // mug
  else if(r<.6) plant(.72,-.05,g,.45);
  else if(r<.75) box(.3,.03,.2,M.white,-.65,.785,.05,g,false);       // notebook
  // chair
  const ch=new THREE.Group(); ch.position.set(0,0,.9); g.add(ch);
  const cm=M.chair;
  box(.46,.07,.46,cm,0,.48,0,ch); box(.44,.5,.06,cm,0,.78,.22,ch);
  mesh(G.cyl,M.black,.035,.4,.035,0,.25,0,ch); box(.5,.04,.05,M.black,0,.05,0,ch); box(.05,.04,.5,M.black,0,.05,0,ch);
  const sp={zone:z, pos:V(x,0,dz+.9), via:[V(z.cx,0,dz+.9)], sit:true, face:Math.PI, type:'desk', screenMat:mm, glow:0, ph:rnd()*6};
  spots.push(sp);
}

function buildOffice(z){
  // columns / rows
  const cols = Math.min(2, Math.max(1, Math.floor((z.w/2-2.3)/2.6)+1));
  const perRow = cols*2;
  const maxRows = Math.floor((z.d-1.4)/2.4);
  const rows = Math.min(maxRows, Math.max(1, Math.ceil(z.head/perRow)));
  const spots=[];
  const startZ = z.s<0 ? z.z0+2.0 : z.z1-2.0;  // far wall side
  const stepZ  = z.s<0 ? 2.5 : -2.5;
  for(let r=0;r<(z.head?rows:0);r++){
    const dz = startZ + r*stepZ;
    for(let c=0;c<cols;c++){
      const off=1.4+c*2.6;
      buildDesk(z, z.cx-off, dz, spots);
      buildDesk(z, z.cx+off, dz, spots);
    }
  }
  z.deskSpots=spots;

  // zone-specific decor
  const zEnd = z.s<0 ? z.z0 : z.z1;
  if(z.racks){
    // server racks along both side walls
    const nRack=3;
    for(const sx of [-1,1]){
      for(let i=0;i<nRack;i++){
        const rx=z.cx+sx*3.75, rz=z.s<0? z.z0+2+i*1.35 : z.z1-2-i*1.35;
        const rk=new THREE.Group(); rk.position.set(rx,0,rz); world.add(rk);
        box(.9,2.2,1.1,M.rack,0,1.1,0,rk);
        const leds=new THREE.InstancedMesh(new THREE.BoxGeometry(.06,.04,.02), new THREE.MeshBasicMaterial({toneMapped:false}), 40);
        const dummy=new THREE.Object3D(); const c=new THREE.Color();
        for(let k=0;k<40;k++){ dummy.position.set(-.3+(k%10)*.066, .35+Math.floor(k/10)*.45+(k%2)*.05, sx<0? .56:.56);
          dummy.position.z = (sx<0 ? 0.56 : 0.56); // front faces +z
          dummy.updateMatrix(); leds.setMatrixAt(k,dummy.matrix); leds.setColorAt(k, c.set(rnd()<.8?0x35ff8f:0x5be7ff).multiplyScalar(2)); }
        rk.add(leds); ledInst.push(leds);
      }
    }
  }
  if(z.lobby){
    // reception counter near entrance + sofa + plants
    box(2.6,1.0,.7,M.white,z.cx+2.2,.5,z.s*(z.z1-3.6),world);
    const neonB=new THREE.MeshBasicMaterial({color:z.col.clone().multiplyScalar(1.8),toneMapped:false});
    box(2.6,.05,.72,neonB,z.cx+2.2,1.02,z.s*(z.z1-3.6),world,false);
    box(2.2,.45,.9,M.fabric,z.cx-2.3,.25,10.0,world); box(2.2,.5,.2,M.fabric,z.cx-2.3,.65,10.4,world);
    plant(z.cx-3.3,16.8,world,1.6); plant(z.cx+3.3,16.8,world,1.6); plant(z.cx-3.3,4.2,world,1.4);
  } else {
    plant(z.x0+.7, z.s<0? z.z0+.8 : z.z1-.8, world, 1.5);
    plant(z.x1-.7, z.s<0? z.z0+.8 : z.z1-.8, world, 1.5);
  }
  // wall screen
  if(z.s<0){ makeScreen(z, Math.min(5.6,z.w-2.6), Math.min(5.6,z.w-2.6)/2, z.cx, 2.0, z.z0+.12); }
  else { const sw=Math.min(5.2, z.w/2-1.5); makeScreen(z, sw, sw/2, z.cx-1.4-sw/2, 1.95, 2.12); }
}

function buildMeeting(z){
  const tz=[-6.5,-12.5], tx=26.7;
  tz.forEach(zz=>{
    box(4.0,.08,1.6,M.white,tx,.75,zz,world); box(.15,.72,1.2,M.deskLeg,tx-1.6,.36,zz,world); box(.15,.72,1.2,M.deskLeg,tx+1.6,.36,zz,world);
    const neon=new THREE.MeshBasicMaterial({color:z.col.clone().multiplyScalar(1.8),toneMapped:false}); box(3.9,.02,.04,neon,tx,.8,zz,world,false);
    const seat=(x,y,rot,via)=>{
      const ch=new THREE.Group(); ch.position.set(x,0,y); ch.rotation.y=rot; world.add(ch);
      box(.46,.07,.46,M.chair,0,.48,0,ch); box(.44,.5,.06,M.chair,0,.78,-.22,ch); mesh(G.cyl,M.black,.035,.4,.035,0,.25,0,ch);
      const face=Math.atan2(tx-x, zz-y);
      z.seats.push({zone:z,pos:V(x,0,y),via,sit:true,face,type:'seat',taken:false});
    };
    [25.2,26.7,28.2].forEach(x=>{ seat(x,zz-1.25,Math.PI,[V(23.3,0,zz-1.25)]); seat(x,zz+1.25,0,[V(23.3,0,zz+1.25)]); });
    seat(24.1,zz,-Math.PI/2,[V(23.3,0,zz)]);
    seat(29.3,zz,Math.PI/2,[V(23.3,0,zz-1.9),V(29.3,0,zz-1.9)]);
  });
  // glowing projector bar & plants
  plant(29.3,-3.2,world,1.5); plant(21.7,-16.9,world,1.5);
  makeScreen(z, 5.6, 2.8, z.cx, 2.0, -17.88);
}

function buildCafe(z){
  // shared builder for Cafeteria and the Lounge (agents rest here when idle)
  const x0=z.x0, tx=x0+5.2, aisle=x0+2.2, lounge=z.kind==='lounge';
  const zs = lounge ? [5.2,9.6,14.0] : [4.8,8.0,11.2,14.4];
  zs.forEach(zz=>{
    mesh(G.cyl, lounge?M.wood:M.white, lounge?.5:.6,.05,lounge?.5:.6,tx,lounge?.45:.75,zz,world);
    mesh(G.cyl,M.deskLeg,.06,lounge?.42:.72,.06,tx,lounge?.22:.36,zz,world); mesh(G.cyl,M.deskLeg,.3,.03,.3,tx,.02,zz,world);
    const seat=(x,y,via)=>{ const ch=new THREE.Group(); ch.position.set(x,0,y); world.add(ch);
      if(lounge){ mesh(G.sph,M.fabric,.34,.24,.34,0,.24,0,ch); }
      else { mesh(G.cyl,M.wood,.23,.06,.23,0,.46,0,ch); mesh(G.cyl,M.black,.03,.4,.03,0,.24,0,ch); }
      z.seats.push({zone:z,pos:V(x,0,y),via,sit:true,face:Math.atan2(tx-x,zz-y),type:'seat',taken:false}); };
    seat(tx-.95,zz,[V(aisle,0,zz)]); seat(tx,zz-.95,[V(aisle,0,zz-.95)]); seat(tx,zz+.95,[V(aisle,0,zz+.95)]);
    seat(tx+.95,zz,[V(aisle,0,zz-1.6),V(tx+.95,0,zz-1.6)]);
  });
  const neon=new THREE.MeshBasicMaterial({color:z.col.clone().multiplyScalar(1.8),toneMapped:false});
  if(!lounge){
    const cz=16.7;
    box(6.2,1.05,.8,M.wood,x0+5.5,.52,cz,world); box(6.2,.05,.82,neon,x0+5.5,1.07,cz,world,false);
    box(.6,.5,.5,M.black,x0+3.4,1.33,cz,world); box(.5,.12,.4,new THREE.MeshBasicMaterial({color:0xff8844,toneMapped:false}),x0+3.4,1.45,cz-.05,world,false);
    box(.8,1.9,.7,M.rack,x0+8.2,.95,12.5,world);
    box(.7,1.3,.04,new THREE.MeshBasicMaterial({color:0x5be7ff,toneMapped:false}),x0+8.2,1.1,12.14,world,false);
    [2.8,4.0,5.2,6.4,7.6].forEach(dx=> z.bar.push({zone:z,pos:V(x0+dx,0,15.6),via:[V(aisle,0,15.6)],sit:false,face:0,type:'bar',taken:false}));
  } else {
    box(3.2,.5,1.0,M.fabric,x0+5.2,.25,16.9,world); box(3.2,.6,.22,M.fabric,x0+5.2,.7,17.4,world);   // sofa
    box(.9,.04,.9,neon,x0+5.2,.03,3.4,world,false);
  }
  plant(z.x1-.7,3.2,world,1.5); plant(x0+.7,17,world,1.5);
  const sw=lounge?4.0:4.6; makeScreen(z, sw, sw/2, z.x1-(lounge?2.6:3.0), 1.95, 2.12);
}

/* zone floors + lights + labels */
ZONES.forEach(z=>{
  const base = z.col.clone().lerp(new THREE.Color(0x2a3350),.86);
  const t=tileTex.clone(); t.repeat.set(z.w/2,z.d/2); t.needsUpdate=true;
  const mat=new THREE.MeshStandardMaterial({color:base, roughness:.4, metalness:.2, map:t, emissive:z.col, emissiveIntensity:.0});
  const f=new THREE.Mesh(new THREE.PlaneGeometry(z.w,z.d),mat); f.rotation.x=-Math.PI/2; f.position.set(z.cx,.004,z.cz); f.receiveShadow=true;
  f.userData.zone=z; world.add(f); hoverTargets.push(f); z.floor=f; z.mat=mat;
  // neon floor outline
  const o=new THREE.MeshBasicMaterial({color:z.col.clone().multiplyScalar(1.5),toneMapped:false});
  const e=.06;
  box(z.w-.2,.012,e,o,z.cx,.012,z.z0+.1,world,false); box(z.w-.2,.012,e,o,z.cx,.012,z.z1-.1,world,false);
  box(e,.012,z.d-.2,o,z.x0+.1,.012,z.cz,world,false); box(e,.012,z.d-.2,o,z.x1-.1,.012,z.cz,world,false);
  buildWalls(z);
  z.head=z.kind==='office'&&!z.lobby?Math.max(z.min,(countByZone[z.id]||0)+1):0;
  if(z.kind==='office') buildOffice(z); else if(z.kind==='meeting') buildMeeting(z); else buildCafe(z);
  // light
  const pl=new THREE.PointLight(z.color, 10, 17, 2); pl.position.set(z.cx,4.1,z.cz); scene.add(pl); zoneLights.push(pl); z.light=pl;
  // label
  const el=document.createElement('div'); el.className='zl'; el.style.setProperty('--c',hex(z.color));
  el.innerHTML=`${z.name}<span>0</span>`;
  const lab=new CSS2DObject(el); lab.position.set(z.cx,3.9,z.cz); scene.add(lab);
  z.labelEl=el; z.labelCount=el.querySelector('span');
});

// Brand sign
let logoEl=null;
function updateBrand(){ const n=(DATA.company&&DATA.company.name)||'Paperclip'; document.getElementById('brandName').textContent=n+' HQ'; document.title=n+' — Mô phỏng văn phòng 3D'; if(logoEl) logoEl.innerHTML=esc(n.toUpperCase())+'<small>HEADQUARTERS</small>'; }
{
  const el=document.createElement('div'); el.className='logo'; el.innerHTML='<small>HEADQUARTERS</small>'; logoEl=el;
  const l=new CSS2DObject(el); l.position.set(-26,5.2,19); scene.add(l);
  // entrance carpet
  box(2.6,.015,3,new THREE.MeshBasicMaterial({color:0x5be7ff,toneMapped:false}),-26,.02,19.6,world,false);
}

/* ============================================================
   Agents (real Paperclip agents)
   ============================================================ */
// Only `running` (and `queued`, which is about to run) agents sit in the offices.
// Everyone else rests: blocked/error wait in the meeting room, paused agents rest in the
// Lounge, idle/assigned/just-finished agents hang out in the Cafeteria and Lounge.
const MODE = {
  running:  {c:0x4ade80, t:'Đang chạy',          i:'⚙'},
  queued:   {c:0x9be564, t:'Sắp chạy (đang xếp hàng)', i:'⏳'},
  assigned: {c:0x5be7ff, t:'Có việc, chưa chạy', i:'📋'},
  blocked:  {c:0xff7a59, t:'Bị chặn',            i:'⛔'},
  paused:   {c:0x8d9bbd, t:'Tạm dừng',           i:'⏸'},
  error:    {c:0xff4d6d, t:'Lỗi',                i:'⚠'},
  justdone: {c:0xffc24b, t:'Vừa hoàn thành',     i:'✅'},
  idle:     {c:0x8d9bbd, t:'Đang rảnh',          i:'💤'},
};
function makePerson(shirtColor, skinMat, hairMat, pantsMat){
  const root=new THREE.Group();
  const shirt=new THREE.MeshStandardMaterial({color:shirtColor, roughness:.75});
  const body=new THREE.Group(); root.add(body);
  const torso=new THREE.Mesh(G.cap,shirt); torso.scale.set(1,1,.72); torso.position.y=1.16; torso.castShadow=true; body.add(torso);
  const head=new THREE.Mesh(G.sph,skinMat); head.scale.setScalar(.135); head.position.y=1.62; head.castShadow=true; body.add(head);
  const hair=new THREE.Mesh(G.sph,hairMat); hair.scale.set(.145,.115,.15); hair.position.set(0,1.67,-.015); hair.castShadow=true; body.add(hair);
  const mk=(x,y,mat)=>{ const p=new THREE.Group(); p.position.set(x,y,0); body.add(p); const m=new THREE.Mesh(G.box,mat); m.castShadow=true; p.add(m); return {p,m}; };
  const legs=[], arms=[];
  for(const sx of [-1,1]){
    const l=new THREE.Group(); l.position.set(sx*.085,.88,0); root.add(l);
    const th=new THREE.Mesh(G.box,pantsMat); th.scale.set(.13,.44,.15); th.position.y=-.22; th.castShadow=true; l.add(th);
    const kn=new THREE.Group(); kn.position.y=-.44; l.add(kn);
    const sh=new THREE.Mesh(G.box,pantsMat); sh.scale.set(.11,.42,.13); sh.position.y=-.21; sh.castShadow=true; kn.add(sh);
    const ft=new THREE.Mesh(G.box,M.black); ft.scale.set(.11,.06,.2); ft.position.set(0,-.43,.04); kn.add(ft);
    legs.push({l,kn});
    const a=new THREE.Group(); a.position.set(sx*.235,1.4,0); body.add(a);
    const up=new THREE.Mesh(G.box,shirt); up.scale.set(.085,.3,.09); up.position.y=-.15; up.castShadow=true; a.add(up);
    const el=new THREE.Group(); el.position.y=-.3; a.add(el);
    const lo=new THREE.Mesh(G.box,skinMat); lo.scale.set(.075,.28,.08); lo.position.y=-.14; lo.castShadow=true; el.add(lo);
    arms.push({a,el});
  }
  root.userData={body,legs,arms,head,shirt};
  return root;
}



const agents = new Map();
const empRoots = [];

function ensureAgent(d){
  let e=agents.get(d.id);
  if(e){ e.data=d; return e; }
  const z=ZB[zoneOf(d)];
  const rng=mulberry32(hash(d.id));
  const pk=a=>a[Math.floor(rng()*a.length)];
  const shirt=z.col.clone().lerp(new THREE.Color(0xffffff),rng()*.25).multiplyScalar(.6+rng()*.3);
  const root=makePerson(shirt,pk(M.skin),pk(M.hair),pk(M.pants));
  scene.add(root);
  // status ring + floating label
  const ringMat=new THREE.MeshBasicMaterial({color:0x8d9bbd,transparent:true,opacity:.9,toneMapped:false,side:THREE.DoubleSide,depthWrite:false});
  const ring=new THREE.Mesh(new THREE.RingGeometry(.34,.44,32),ringMat); ring.rotation.x=-Math.PI/2; root.add(ring);
  const el=document.createElement('div'); el.className='al'; el.innerHTML='<i>💤</i><span></span>';
  el.querySelector('span').textContent=d.name;
  const lab=new CSS2DObject(el); lab.position.set(0,2.15,0); root.add(lab);
  // desk
  const free=z.deskSpots.find(s=>!s.owner) || ZONES.flatMap(q=>q.deskSpots||[]).find(s=>!s.owner) || z.deskSpots[0];
  e={ id:d.id, data:d, zone:z, desk:free, root, ring, ringMat, labelEl:el, iconEl:el.querySelector('i'),
      state:'work', loc:null, path:[], nextState:null, until:0, sit:0, ph:rng()*6, spd:1.3+rng()*.5, yaw:0, sitting:false,
      mode:null, want:'leisure', spot:null, activityTitle:'', issue:null, placed:false };
  if(free) free.owner=e;
  root.userData.emp=e; root.traverse(o=>{ if(o.isMesh) o.userData.emp=e; });
  agents.set(d.id,e); z.people.push(e); empRoots.push(root);
  return e;
}
function removeAgent(e){
  scene.remove(e.root); agents.delete(e.id); e.zone.people=e.zone.people.filter(p=>p!==e);
  empRoots.splice(empRoots.indexOf(e.root),1); if(e.desk) e.desk.owner=null; if(e.spot&&e.spot.taken!==undefined) e.spot.taken=false;
  if(follow===e) follow=null; if(selEmp===e) clearSel();
}
function syncAgents(){
  const ids=new Set(DATA.agents.map(a=>a.id));
  for(const e of [...agents.values()]) if(!ids.has(e.id)) removeAgent(e);
  DATA.agents.forEach(ensureAgent);
}

/* ------ pathing ------ */
function buildPath(from, to){
  const lane=Rr(-1.05,1.05), p=[]; const push=v=>p.push(v.clone());
  from.via.forEach(push);
  if(from.zone!==to.zone){ push(from.zone.doorIn); push(V(from.zone.doorX,0,lane)); push(V(to.zone.doorX,0,lane)); push(to.zone.doorIn); }
  [...to.via].reverse().forEach(push);
  push(to.pos);
  return p;
}
function goTo(e, spot, state, until=0){
  if(e.spot && e.spot.taken!==undefined) e.spot.taken=false;
  e.path=buildPath(e.loc, spot); e.dest=spot; e.nextState=state; e.until=until; e.state='walk'; e.sitting=false;
  e.spot=spot.taken!==undefined?spot:null; if(e.spot) e.spot.taken=true;
}
function teleport(e, spot, state, until=0){
  e.loc=spot; e.dest=spot; e.path=[]; e.state=state; e.until=until; e.sitting=spot.sit; e.root.position.copy(spot.pos); if(spot.face!==null&&spot.face!==undefined) e.yaw=spot.face;
  e.spot=spot.taken!==undefined?spot:null; if(e.spot) e.spot.taken=true; e.sit=spot.sit?1:0; e.placed=true;
}
function standSpot(zone, kind){
  if(kind==='chat') return {zone, pos:V(zone.doorX+Rr(-.9,.9),0,zone.s*(3.8+Rr(0,5))), via:[], sit:false, face:null, type:'chat'};
  return {zone, pos:V(zone.doorX+Rr(.8,4),0,zone.s*(3.8+Rr(0,8))), via:[], sit:false, face:null, type:'stand'};
}
function freeOf(list){ const f=list.filter(s=>!s.taken); return f.length?pick(f):null; }

// Where a non-working agent goes. Offices are reserved for agents that are actually running.
function leisurePlan(e){
  const m=e.mode;
  if(m==='blocked'||m==='error'){
    const s=freeOf(ZB.meet.seats);
    if(s) return {sp:s,state:'meet',title:m==='error'?'Chờ xử lý lỗi':'Chờ gỡ vướng',dur:Rr(120,240)};
  }
  if(m==='paused'){
    const s=freeOf(ZB.lounge.seats);
    if(s) return {sp:s,state:'cafe',title:'Đang nghỉ (tạm dừng)',dur:Rr(240,480)};
    return {sp:standSpot(ZB.lounge,'stand'),state:'cafe',title:'Đang nghỉ (tạm dừng)',dur:Rr(120,240)};
  }
  const r=Math.random();
  if(m==='justdone' || r<.35){ const s=freeOf(ZB.cafe.bar); if(s) return {sp:s,state:'cafe',title:m==='justdone'?'Xong việc, đi lấy cà phê':'Lấy cà phê',dur:Rr(18,40)}; }
  if(r<.75){ const s=freeOf(ZB.cafe.seats); if(s) return {sp:s,state:'cafe',title:'Ngồi ở Cafeteria',dur:Rr(40,90)}; }
  { const s=freeOf(ZB.lounge.seats); if(s) return {sp:s,state:'cafe',title:'Nghỉ ở Khu nghỉ',dur:Rr(40,90)}; }
  return {sp:standSpot(ZB.cafe,'stand'),state:'chat',title:'Trò chuyện ở Cafeteria',dur:Rr(20,40)};
}
function pickLeisure(e,t,instant){
  const p=leisurePlan(e); e.activityTitle=p.title;
  if(instant) teleport(e,p.sp,p.state,t+p.dur); else goTo(e,p.sp,p.state,t+p.dur);
}

/* ============================================================
   Mode computation from real data
   ============================================================ */
const T = s => s?new Date(s).getTime():0;
let replay=null;           // {vt,t0,t1,speed}
let firstModes=true;
function computeMode(e, nowMs){
  const d=e.data, runs=((replay&&DATA.allRuns)||DATA.runs).filter(r=>r.agentId===d.id);
  let live=null, queued=null;
  if(!replay){
    live=runs.find(r=>r.status==='running');
    if(!live && d.status==='running') live={};          // run older than the live window
    if(!live) queued=runs.find(r=>r.status==='queued');
  }
  else live=runs.find(r=>r.startedAt && T(r.startedAt)<=nowMs && (!r.finishedAt || T(r.finishedAt)>nowMs));
  const open=DATA.issues.filter(i=>i.assigneeAgentId===d.id&&isOpen(i));
  const cur=live||queued;
  e.issue = (cur&&cur.issueId&&issueById(cur.issueId)) || open.find(i=>i.status==='in_progress') || open.find(i=>i.status==='blocked') || open[0] || null;
  e.liveRun=live;
  if(live) return 'running';
  if(!replay){ if(d.status==='error') return 'error'; if(d.status==='paused'||d.pausedAt) return 'paused'; }
  if(queued) return 'queued';
  const done=runs.filter(r=>r.finishedAt&&T(r.finishedAt)<=nowMs).sort((a,b)=>T(b.finishedAt)-T(a.finishedAt))[0];
  e.lastRun=done||null;
  if(done && nowMs-T(done.finishedAt)<90000 && done.status==='succeeded') return 'justdone';
  if(open.some(i=>i.status==='blocked')) return 'blocked';
  if(open.length) return 'assigned';
  return 'idle';
}
function setModes(nowMs, quiet){
  for(const e of agents.values()){
    const m=computeMode(e,nowMs), prev=e.mode;
    if(m!==prev){
      e.mode=m; MODEv[e.id]=m;
      const mm=MODE[m]; e.ringMat.color.setHex(mm.c); e.labelEl.style.setProperty('--c',hex(mm.c)); e.iconEl.textContent=mm.i;
      e.want = (m==='running'||m==='queued') ? 'desk' : 'leisure';
      e.until = 0;                       // re-plan at once: a resting mode change may mean a new place
      e.labelEl.classList.toggle('rest', e.want!=='desk');
      if(prev && !quiet){
        const id=e.issue?(' · '+(e.issue.identifier||'')):'';
        const nm=esc(e.data.name);
        if(m==='running') log(`⚙ <b>${nm}</b> bắt đầu chạy${id}`, e.zone.color, nowMs);
        else if(prev==='running'){ const st=e.lastRun&&e.lastRun.status; log(st==='succeeded'?`✅ <b>${nm}</b> hoàn thành lượt chạy`: st==='failed'?`❌ <b>${nm}</b> lượt chạy lỗi`:`⏹ <b>${nm}</b> dừng lượt chạy`, e.zone.color, nowMs); }
        else if(m==='blocked') log(`⛔ <b>${nm}</b> bị chặn${id}`, 0xff7a59, nowMs);
        else if(m==='error') log(`⚠ <b>${nm}</b> gặp lỗi`, 0xff4d6d, nowMs);
        else if(m==='paused') log(`⏸ <b>${nm}</b> bị tạm dừng`, 0x8d9bbd, nowMs);
      }
    }
    if(!e.placed && e.desk){ if(e.want==='desk') teleport(e,e.desk,'work'); else pickLeisure(e,elapsed,true); }
  }
}

/* ============================================================
   Activity feed / log
   ============================================================ */
const logList=document.getElementById('loglist');
function log(html, color, ms=Date.now()){
  const li=document.createElement('li'); li.style.setProperty('--c',color?hex(color):'#5be7ff');
  li.innerHTML=`<time>${timeOf(ms)}</time>${html}`;
  logList.prepend(li); while(logList.children.length>8) logList.lastChild.remove();
  const tmp=document.createElement('div'); tmp.innerHTML=html;
  FEED.unshift({time:timeOf(ms), plain:tmp.textContent}); FEED.length=Math.min(FEED.length,12);
}
const NOISE=new Set(['issue.read_marked','budget.policy_upserted','provider_trace.metadata_listed','accounting.retry_requested','environment.lease_released','environment.lease_acquired']);
const ACT={'agent.resumed':['▶','được kích hoạt lại'],'agent.paused':['⏸','bị tạm dừng'],'issue.updated':['📝','cập nhật'],'issue.created':['➕','tạo issue'],'issue.document_created':['📄','tạo tài liệu cho'],'issue.work_product_created':['📦','nộp sản phẩm cho'],'issue.attachment_added':['📎','đính kèm tệp vào'],'cost.reported':['💲','báo cáo chi phí'],'issue.comment_added':['💬','bình luận ở']};
function describeAct(a){
  if(NOISE.has(a.action)) return null;
  const ag=agentById(a.agentId)||(a.entityType==='agent'?agentById(a.entityId):null); const who=ag?ag.name:(a.actorType==='user'?'Bạn':(a.actorType||'Hệ thống'));
  const iss=a.entityType==='issue'?issueById(a.entityId):null; const [ic,tx]=ACT[a.action]||['•',a.action];
  return {html:`${ic} <b>${esc(who)}</b> ${tx}${iss?' '+esc(iss.identifier):''}`, color: ag?(ZB[zoneOf(ag)].color):0x5be7ff, ms:T(a.createdAt)};
}
const seenAct=new Set();
function ingestActivity(first){
  const fresh=DATA.activity.filter(a=>!seenAct.has(a.id)); fresh.forEach(a=>seenAct.add(a.id));
  const items=fresh.map(describeAct).filter(Boolean).sort((a,b)=>a.ms-b.ms);
  (first?items.slice(-6):items).forEach(x=>log(x.html,x.color,x.ms));
}

/* ============================================================
   Agent chat — issue comments are how agents talk to each other
   ============================================================ */
const chatEl=document.getElementById('chat'), chatList=document.getElementById('chatlist');
document.getElementById('chatmin').onclick=function(){ const m=chatEl.classList.toggle('min'); this.textContent=m?'Mở':'Thu gọn'; };
const seenCmt=new Set(); let chatInit=false, chatBusy=false;
const CHAT_MAX=40, BUBBLE_MS=9000, BUBBLE_FRESH=180000;
const mdPlain=s=>String(s||'')
  .replace(/```[\s\S]*?```/g,' [code] ').replace(/!\[[^\]]*\]\([^)]*\)/g,'')
  .replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/<[^>]+>/g,'')
  .replace(/^\s*[-*+]\s+/gm,'• ').replace(/[*_`#>|]+/g,'').replace(/\s+/g,' ').trim();
function say(e,text){
  if(!e.bubble){ const el=document.createElement('div'); el.className='bub'; el.innerHTML='<div></div>';
    const o=new CSS2DObject(el); o.position.set(0,2.95,0); e.root.add(o); e.bubble=o; e.bubbleEl=el; }
  const inner=e.bubbleEl.firstChild; inner.textContent=text.length>120?text.slice(0,120)+'…':text;
  e.bubbleEl.style.setProperty('--c',hex(e.zone.color));
  e.bubbleEl.classList.add('show'); clearTimeout(e.bubbleT);
  e.bubbleT=setTimeout(()=>e.bubbleEl.classList.remove('show'),BUBBLE_MS);
}
function addChat(a,c,live){
  const ag=agentById((c&&c.authorAgentId)||a.agentId);
  const who=ag?ag.name:((c&&c.authorType==='user')||a.actorType==='user'?'Board (bạn)':'Hệ thống');
  const color=ag?ZB[zoneOf(ag)].color:0xffc24b;
  const text=mdPlain(c?c.body:(a.details.bodySnippet||'')); if(!text) return;
  const iss=issueById(a.entityId), ident=a.details.identifier||(iss&&iss.identifier)||'', ms=T(a.createdAt);
  const li=document.createElement('li'); li.style.setProperty('--c',hex(color));
  li.innerHTML=`<div class="ch"><b>${esc(who)}</b><span>${esc(ident)}</span><time>${timeOf(ms)}</time></div><p>${esc(text.length>240?text.slice(0,240)+'…':text)}</p>`;
  li.title=(a.details.issueTitle||'')+' — bấm để mở issue';
  li.onclick=()=>{ const is=issueById(a.entityId); if(is) openIssueModal(is); else toast('Không tìm thấy issue',ident); };
  const empty=chatList.querySelector('.empty'); if(empty) empty.remove();
  chatList.prepend(li); while(chatList.children.length>CHAT_MAX) chatList.lastChild.remove();
  if(live && ag && Date.now()-ms<BUBBLE_FRESH){ const e=agents.get(ag.id); if(e) say(e,text); }
}
async function pollChat(){
  if(chatBusy||!companyId||replay) return; chatBusy=true;
  try{
    const acts=(await jget(companyPath()+'/activity?limit=500'))
      .filter(a=>a.action==='issue.comment_added'&&a.details&&a.details.commentId&&!seenCmt.has(a.details.commentId))
      .sort((a,b)=>T(a.createdAt)-T(b.createdAt));
    acts.forEach(a=>seenCmt.add(a.details.commentId));
    const pick=chatInit?acts:acts.slice(-15);
    const bodies=new Map();
    await Promise.all([...new Set(pick.map(a=>a.entityId))].map(id=>
      jget('/issues/'+id+'/comments').then(cs=>cs.forEach(c=>bodies.set(c.id,c))).catch(()=>{})));
    pick.forEach(a=>addChat(a,bodies.get(a.details.commentId),chatInit));
    if(!chatInit && !pick.length) chatList.innerHTML='<li class="empty" style="border:0;background:none;cursor:default">Chưa có bình luận nào gần đây.</li>';
    chatInit=true;
  }catch(e){} finally{ chatBusy=false; }
}
setInterval(pollChat,5000);
// keep the chat panel just above the camera buttons, which wrap to two rows on narrow screens
const camsEl=document.getElementById('cams');
const placeChat=()=>{ chatEl.style.bottom=(camsEl.offsetHeight+26)+'px'; };
addEventListener('resize',placeChat); placeChat();

/* ------ toasts ------ */
/* ============================================================
   Toasts
   ============================================================ */
const toastEl=document.createElement('div');
toastEl.style.cssText='position:fixed;left:50%;top:92px;transform:translate(-50%,-20px);opacity:0;transition:.4s;pointer-events:none;z-index:5;padding:10px 18px;text-align:center';
toastEl.className='glass'; document.body.appendChild(toastEl);
let toastT=0;
function toast(t,s){ toastEl.innerHTML=`<b style="font-size:14px">${t}</b><div style="font-size:11px;color:var(--mut);margin-top:2px">${s}</div>`; toastEl.style.opacity=1; toastEl.style.transform='translate(-50%,0)'; clearTimeout(toastT); toastT=setTimeout(()=>{toastEl.style.opacity=0;toastEl.style.transform='translate(-50%,-20px)';},3800); }



/* ============================================================
   Simulation update
   ============================================================ */
const _v=new THREE.Vector3();
function updateEmp(e, dt, t){
  if(!e.placed) return;
  const r=e.root, ud=r.userData;
  const moving = e.state==='walk';
  if(moving){
    const tgt=e.path[0];
    if(tgt){
      const dx=tgt.x-r.position.x, dz=tgt.z-r.position.z, d=Math.hypot(dx,dz), step=e.spd*(e.want==='desk'?2.1:1.25)*dt;   // hurry to the desk when work starts
      if(d<=step){ r.position.x=tgt.x; r.position.z=tgt.z; e.path.shift(); }
      else { r.position.x+=dx/d*step; r.position.z+=dz/d*step; const ty=Math.atan2(dx,dz); let da=ty-e.yaw; da=Math.atan2(Math.sin(da),Math.cos(da)); e.yaw+=da*Math.min(1,dt*10); }
      e.ph+=dt*8*(e.spd/1.6);
    }
    if(!e.path.length){ e.loc=e.dest; e.state=e.nextState; e.sitting=e.dest.sit; if(e.dest.face!==null&&e.dest.face!==undefined) e.yaw=e.dest.face; }
  } else {
    if(e.want==='desk'){ if(e.loc!==e.desk && e.desk) goTo(e,e.desk,'work'); }
    else if(e.loc===e.desk || t>=e.until) pickLeisure(e,t);
  }
  /* pose */
  e.sit += ((e.sitting?1:0)-e.sit)*Math.min(1,dt*7);
  const sit=e.sit, wk=moving?1:0, sw=Math.sin(e.ph)*.75*wk*(1-sit);
  r.rotation.y=e.yaw;
  r.position.y = -.38*sit + (moving? Math.abs(Math.sin(e.ph))*.025:0);
  e.ring.position.y=.03-r.position.y;
  ud.legs[0].l.rotation.x = lerp(sw, -Math.PI/2, sit);
  ud.legs[1].l.rotation.x = lerp(-sw, -Math.PI/2, sit);
  ud.legs[0].kn.rotation.x = lerp(Math.max(0,-sw)*1.1, Math.PI/2, sit);
  ud.legs[1].kn.rotation.x = lerp(Math.max(0,sw)*1.1, Math.PI/2, sit);
  let aL, aR, eL=.05, eR=.05, headX=0;
  if(moving){ aL=-sw*.9; aR=sw*.9; eL=.25; eR=.25; }
  else if(e.state==='work'){
    if(e.mode==='running'){ const ty=Math.sin(t*13+e.ph)*.07, tz=Math.sin(t*11+e.ph*2)*.07; aL=-.75+ty; aR=-.75+tz; eL=-1.0; eR=-1.0; }
    else if(e.mode==='blocked'||e.mode==='error'){ aL=-.5; aR=-.9; eL=-1.7; eR=-1.7; headX=.25; }   // hand on head
    else { aL=-.5+Math.sin(t*.9+e.ph)*.03; aR=-.5; eL=-.8; eR=-.8; }
  }
  else if(e.state==='meet'){ aL=-.7; aR=-.7+Math.sin(t*1.5+e.ph)*.05; eL=-.7; eR=-.9+(Math.sin(t*.9+e.ph)>.8?Math.sin(t*6)*.3:0); }
  else if(e.state==='cafe'){ const sip=Math.max(0,Math.sin(t*.7+e.ph)); aL=-.7; aR=-.7-sip*.6; eL=-.5; eR=-.5-sip*1.0; }
  else { const g=Math.sin(t*2.2+e.ph); aL=-.3; aR=-.5+g*.3; eL=-.5; eR=-.9+g*.4; }
  ud.arms[0].a.rotation.x=aL; ud.arms[1].a.rotation.x=aR; ud.arms[0].el.rotation.x=eL; ud.arms[1].el.rotation.x=eR;
  ud.head.rotation.y = (e.state==='chat'||e.state==='meet') ? Math.sin(t*.8+e.ph)*.4 : 0;
  ud.head.rotation.x = headX;
  ud.body.rotation.z = !moving&&sit<.5 ? Math.sin(t*1.2+e.ph)*.02 : 0;
  e.ringMat.opacity = (e.mode==='running' ? .6+.4*Math.sin(t*5) : .75)*(e.dimF??1);
}

/* ============================================================
   Interaction: hover / select / focus
   ============================================================ */
const ray=new THREE.Raycaster(); const mouse=new THREE.Vector2(); let hoverZone=null, hoverEmp=null, selZone=null, selEmp=null;
let pointerDown=null;
renderer.domElement.addEventListener('pointermove',ev=>{
  mouse.set(ev.clientX/innerWidth*2-1, -(ev.clientY/innerHeight)*2+1);
});
renderer.domElement.addEventListener('pointerdown',ev=>{ pointerDown={x:ev.clientX,y:ev.clientY}; stopTour(); camAnim=null; });
renderer.domElement.addEventListener('pointerup',ev=>{
  if(!pointerDown) return; const moved=Math.hypot(ev.clientX-pointerDown.x,ev.clientY-pointerDown.y); pointerDown=null;
  if(moved>5) return;
  if(pendingAssign&&hoverEmp){ const is=pendingAssign; pendingAssign=null; banner.classList.remove('show'); doAssign(is,hoverEmp); } else if(hoverEmp) selectEmp(hoverEmp); else if(hoverZone) selectZone(hoverZone); else { clearSel(); }
});
function pickScene(){
  ray.setFromCamera(mouse,camera);
  const vis=empRoots.filter(r=>r.visible);
  const he=ray.intersectObjects(vis,true);
  hoverEmp = he.length ? he[0].object.userData.emp : null;
  const hz=ray.intersectObjects(hoverTargets,false);
  hoverZone = hz.length ? hz[0].object.userData.zone : null;
  renderer.domElement.style.cursor = (hoverEmp||hoverZone)?'pointer':'grab';
}
const nameLabelEl=document.createElement('div'); nameLabelEl.className='nl';
const nameLabel=new CSS2DObject(nameLabelEl); nameLabel.visible=false; scene.add(nameLabel);

let camAnim=null;
function flyTo(pos, target, dur=1.3){
  camAnim={p0:camera.position.clone(), t0:controls.target.clone(), p1:pos, t1:target, s:performance.now(), dur:dur*1000};
}
function focusZone(z){
  const dist=(Math.max(z.w*.9,z.d*.75)+6)*Math.max(1,1.5/camera.aspect)**.7;
  const t=V(z.cx,0,z.cz+z.s*-1.5);
  flyTo(V(z.cx+dist*.12, dist*.72, t.z+dist*.78), t);
}
function selectZone(z){
  selZone=z; selEmp=null; follow=null; focusZone(z); renderPanel(); markDept();
}
let follow=null;
function selectEmp(e){
  selEmp=e; selZone=e.zone; follow=e; renderPanel(); markDept();
  const off=camera.position.clone().sub(controls.target);
  if(off.length()>26) flyTo(e.root.position.clone().add(V(0,0,0)).add(off.setLength(16)), e.root.position.clone().add(V(0,1,0)));
}
function clearSel(){ selZone=null; selEmp=null; follow=null; renderPanel(); markDept(); }



/* ============================================================
   UI
   ============================================================ */
const dlist=document.getElementById('dlist'), panel=document.getElementById('panel');
ZONES.forEach(z=>{
  const d=document.createElement('div'); d.className='dept'; d.style.setProperty('--c',hex(z.color)); d.dataset.id=z.id;
  d.innerHTML=`<span class="dot"></span><div class="nm">${z.name}<small>${z.en}</small><div class="bar"><i></i></div></div><span class="ct">–</span>`;
  d.onclick=()=>selectZone(z); dlist.appendChild(d); z.listEl=d;
});
function markDept(){ ZONES.forEach(z=>z.listEl.classList.toggle('sel',z===selZone)); }
function initials(n){ const p=n.replace(/[()\/&]/g,' ').split(/\s+/).filter(Boolean); return ((p[0]||'?')[0]+((p[1]||'')[0]||'')).toUpperCase(); }
const modeDot=m=>`<span style="color:${hex(MODE[m||'idle'].c)}">●</span> ${MODE[m||'idle'].t}`;

function renderPanel(){
  if(!selZone){ panel.classList.remove('show'); return; }
  panel.classList.add('show'); const z=selZone; panel.style.setProperty('--c',hex(z.color));
  if(selEmp){
    const e=selEmp, d=e.data, mg=agentById(d.reportsTo);
    panel.innerHTML=`<div class="hd"><div class="sw" style="display:grid;place-items:center;font-weight:800;color:#06101a">${esc(initials(d.name))}</div><div><b>${esc(d.name)}</b><small>${esc(d.title||d.role)} · ${z.name}</small></div><button class="x" id="px">✕</button></div>
      <div class="row"><span>Trạng thái</span><span id="e-st"></span></div>
      <div class="row"><span>Vị trí</span><span id="e-loc"></span></div>
      <div class="row"><span>Báo cáo cho</span><span>${mg?esc(mg.name):'—'}</span></div>
      <div class="row"><span>Adapter</span><span>${esc(d.adapterType||'—')}</span></div>
      <div class="row"><span>Dự án</span><span id="e-prj"></span></div>
      <div class="row"><span>Heartbeat cuối</span><span id="e-hb"></span></div>
      <div class="row"><span>Chi tiêu tháng</span><span id="e-sp"></span></div>
      <h4 style="margin-top:12px">Issue được giao</h4><div class="people" id="e-iss"></div>
      <div style="margin-top:12px;display:flex;gap:6px"><button id="pb">← ${z.name}</button><button id="pf" class="on">Đang theo dõi</button><button id="pa" class="on">＋ Giao task</button></div>`;
    panel.querySelector('#pa').onclick=()=>openCreateModal(e.id);
    panel.querySelector('#e-iss').onclick=ev=>{ const r=ev.target.closest('[data-iid]'); if(r){ const is=issueById(r.dataset.iid); if(is) openIssueModal(is); } };
    panel.querySelector('#pb').onclick=()=>{ selEmp=null; follow=null; focusZone(z); renderPanel(); };
    panel.querySelector('#pf').onclick=ev=>{ follow=follow?null:e; ev.target.classList.toggle('on',!!follow); ev.target.textContent=follow?'Đang theo dõi':'Theo dõi'; };
  } else {
    panel.innerHTML=`<div class="hd"><div class="sw"></div><div><b>${z.name}</b><small>${z.en}</small></div><button class="x" id="px">✕</button></div>
      <div class="kpis"><div class="kpi"><b id="k-p">0</b><span>Agent</span></div><div class="kpi"><b id="k-w">0</b><span>Đang chạy</span></div><div class="kpi"><b id="k-o">0</b><span>Bị chặn</span></div></div>
      <h4>Nhân sự (${z.people.length})</h4><div class="people" id="plist"></div>`;
    const pl=panel.querySelector('#plist');
    z.people.forEach(e=>{ const r=document.createElement('div'); r.className='pp'; r.style.setProperty('--c',hex(z.color));
      r.innerHTML=`<span class="av">${esc(initials(e.data.name))}</span><span>${esc(e.data.name)}<br><small style="color:var(--mut)">${esc(e.data.title||e.data.role)}</small></span><span class="st"></span>`;
      r.onclick=()=>selectEmp(e); e.rowEl=r; pl.appendChild(r); });
    if(!z.people.length) pl.innerHTML='<div style="color:var(--mut);font-size:12px;padding:6px">Khu vực chung — agent ghé qua khi rảnh hoặc cần trao đổi.</div>';
  }
  panel.querySelector('#px').onclick=clearSel;
}

let lastIssHtml='', lastProjSig='';
const inProject = e => DATA.issues.some(i=>i.projectId===projFilter&&i.assigneeAgentId===e.id&&isOpen(i)) || !!(e.liveRun&&e.issue&&e.issue.projectId===projFilter);
function renderProjects(){
  const box=document.getElementById('projlist');
  const sig=projFilter+'|'+DATA.projects.map(p=>p.id+p.name+DATA.issues.filter(i=>i.projectId===p.id).map(i=>i.status+(i.assigneeAgentId||'')).join('')).join(',');
  if(sig===lastProjSig) return; lastProjSig=sig; box.innerHTML='';
  const mk=(id,name,sub,col,frac,n)=>{ const d=document.createElement('div'); d.className='dept'+(projFilter===id?' sel':''); d.style.setProperty('--c',hex(col));
    d.innerHTML=`<span class="dot"></span><div class="nm">${esc(name)}<small>${sub}</small><div class="bar"><i style="width:${frac*100}%"></i></div></div><span class="ct">${n}</span>`;
    d.onclick=()=>setProject(projFilter===id?null:id); box.appendChild(d); };
  mk(null,'Tất cả dự án',DATA.projects.length+' dự án · '+DATA.issues.filter(isOpen).length+' issue mở',0xffffff,0,DATA.agents.length);
  DATA.projects.forEach(p=>{ const L=DATA.issues.filter(i=>i.projectId===p.id), open=L.filter(isOpen), blk=L.filter(i=>i.status==='blocked'), done=L.filter(i=>i.status==='done');
    const ppl=new Set(open.map(i=>i.assigneeAgentId).filter(Boolean)).size;
    mk(p.id,p.name,`${open.length} mở · ${blk.length} chặn · ${done.length}/${L.length} xong`,projColor(p),L.length?done.length/L.length:0,ppl+' 👤'); });
  if(projFilter===null) box.firstChild.classList.add('sel');
}
function setProject(id){
  projFilter=id; lastProjSig=''; renderProjects();
  const p=DATA.projects.find(x=>x.id===id);
  if(p) toast('📁 '+p.name,'Agent không làm dự án này được làm mờ'); 
  refreshUI();
}
function refreshUI(){
  let run=0,blk=0,idle=0;
  for(const e of agents.values()){ if(e.mode==='running')run++; else if(e.mode==='blocked'||e.mode==='error')blk++; if(e.want!=='desk')idle++; }
  document.getElementById('s-total').textContent=agents.size;
  document.getElementById('s-run').textContent=run;
  document.getElementById('s-block').textContent=blk;
  document.getElementById('s-idle').textContent=idle;
  document.getElementById('s-issue').textContent=curIssues().filter(isOpen).length;
  renderProjects(); renderIssueList();
  for(const e of agents.values()){ const on=!projFilter||inProject(e); e.dimF=on?1:.25; e.labelEl.style.opacity=on?1:.3; }
  const loc={}; for(const e of agents.values()) if(e.state!=='walk'&&e.loc) loc[e.loc.zone.id]=(loc[e.loc.zone.id]||0)+1;
  ZONES.forEach(z=>{
    const ct=z.listEl.querySelector('.ct'), bar=z.listEl.querySelector('.bar i');
    if(z.kind==='office'){ const n=z.people.length, r=z.people.filter(e=>e.mode==='running').length;
      z.labelCount.textContent=n?`${r}/${n}`:'—'; ct.textContent=n?`${r}/${n}`:'–'; bar.style.width=n?(r/n*100)+'%':'0'; }
    else { const h=loc[z.id]||0; z.labelCount.textContent=h+' agent'; ct.textContent=h; bar.style.width=Math.min(100,h/(z.seats.length||8)*100)+'%'; }
  });
  if(selZone && !selEmp && panel.querySelector('#k-p')){
    const z=selZone, $=id=>panel.querySelector(id);
    $('#k-p').textContent=z.people.length; $('#k-w').textContent=z.people.filter(e=>e.mode==='running').length; $('#k-o').textContent=z.people.filter(e=>e.mode==='blocked').length;
    z.people.forEach(e=>{ const st=e.rowEl&&e.rowEl.querySelector('.st'); if(st) st.innerHTML=modeDot(e.mode); });
  }
  if(selEmp && panel.querySelector('#e-st')){
    const e=selEmp, d=e.data;
    panel.querySelector('#e-st').innerHTML=modeDot(e.mode)+(e.issue&&e.mode==='running'?' · '+esc(e.issue.identifier):'');
    panel.querySelector('#e-loc').textContent=e.state==='walk'?'Đang di chuyển':(e.loc?e.loc.zone.name:'—')+(e.state!=='work'&&e.activityTitle?' · '+e.activityTitle:'');
    panel.querySelector('#e-hb').textContent=ago(T(d.lastHeartbeatAt));
    panel.querySelector('#e-prj').textContent=[...new Set(DATA.issues.filter(i=>i.assigneeAgentId===d.id&&isOpen(i)).map(i=>(projectOf(i)||{}).name).filter(Boolean))].join(', ')||'—';
    panel.querySelector('#e-sp').textContent='$'+((d.spentMonthlyCents||0)/100).toFixed(2)+' / $'+((d.budgetMonthlyCents||0)/100).toFixed(0);
    const list=DATA.issues.filter(i=>i.assigneeAgentId===d.id).sort((a,b)=>isOpen(b)-isOpen(a));
    const h=list.map(i=>`<div class="pp" data-iid="${i.id}"><span class="av" style="background:${issCol(i.status)}"></span><span>${esc(i.identifier)} <small style="color:var(--mut)">${esc(i.status)}${projectOf(i)?' · '+esc(projectOf(i).name):''}</small><br><small style="color:var(--mut)">${esc((i.title||'').slice(0,60))}</small></span></div>`).join('')||'<div style="color:var(--mut);font-size:12px;padding:6px">Chưa có issue.</div>';
    if(h!==lastIssHtml){ panel.querySelector('#e-iss').innerHTML=h; lastIssHtml=h; }
  }
}

/* controls */
const modeBtns=document.querySelectorAll('[data-mode]');
async function setMode(m){
  modeBtns.forEach(b=>b.classList.toggle('on',b.dataset.mode===m));
  logList.innerHTML=''; FEED.length=0;
  if(m==='replay'){
    toast('⏪ Đang tải lịch sử…','Lấy toàn bộ lượt chạy từ Paperclip');
    let all=[]; try{ all=await loadAllRuns(); }catch(e){}
    const rs=all.filter(r=>r.startedAt); if(!rs.length){ toast('Chưa có lượt chạy nào','Không có lịch sử để phát lại'); modeBtns.forEach(b=>b.classList.toggle('on',b.dataset.mode==='live')); return; }
    const t0=Math.min(...rs.map(r=>T(r.startedAt)))-60000, t1=Math.max(...rs.map(r=>T(r.finishedAt||r.startedAt)))+120000;
    replay={vt:t0,t0,t1,speed:(t1-t0)/75000};
    agents.forEach(e=>{ e.mode=null; }); setModes(replay.vt,true);
    toast('⏪ Phát lại lịch sử',`${all.length} lượt chạy · ${timeOf(t0)} → ${timeOf(t1)} (≈75 giây)`);
  } else { replay=null; DATA.allRuns=null; agents.forEach(e=>{ e.mode=null; }); setModes(Date.now(),true); seenAct.clear(); ingestActivity(true); }
}
modeBtns.forEach(b=>b.onclick=()=>setMode(b.dataset.mode));
let dayOv=null; const dayBtn=document.getElementById('daybtn');
dayBtn.onclick=()=>{ dayOv= dayOv===null?'day':dayOv==='day'?'night':null; dayBtn.textContent='🌓 '+(dayOv===null?'Auto':dayOv==='day'?'Ngày':'Đêm'); };
const fitK=()=>Math.max(1,1.6/camera.aspect)**.7;
const CAMS={
  iso:()=>[V(0,46,62).multiplyScalar(fitK()),V(0,0,0)], top:()=>[V(0,88,.1).multiplyScalar(fitK()),V(0,0,0)], low:()=>[V(-34,6,34).multiplyScalar(fitK()**.6),V(0,1,0)],
};
document.querySelectorAll('[data-cam]').forEach(b=>b.onclick=()=>{
  stopTour(); clearSel(); const c=CAMS[b.dataset.cam](); flyTo(c[0].clone(),c[1].clone(),1.6);
  document.querySelectorAll('[data-cam]').forEach(x=>x.classList.toggle('on',x===b));
});
let tourOn=false, tourI=0, tourT=0;
function stopTour(){ tourOn=false; document.getElementById('tour').classList.remove('on'); }
document.getElementById('tour').onclick=function(){ tourOn=!tourOn; this.classList.toggle('on',tourOn); if(tourOn){tourT=0;tourI=0;} };
document.getElementById('rot').onclick=function(){ controls.autoRotate=!controls.autoRotate; this.classList.toggle('on',controls.autoRotate); };
let fx=true;
document.getElementById('fxbtn').onclick=function(){ fx=!fx; this.classList.toggle('on',fx); };

/* ============================================================
   Day / night
   ============================================================ */
const SKY=[[0,0x05070f],[5,0x0c1226],[6.5,0xf0926a],[8,0x9ec9f0],[12,0x8fc6f7],[17,0x9fc2e8],[18.5,0xff8a5c],[20,0x141a38],[24,0x05070f]];
const _c1=new THREE.Color(),_c2=new THREE.Color();
function skyColor(h,out){ for(let i=0;i<SKY.length-1;i++){ if(h>=SKY[i][0]&&h<=SKY[i+1][0]){ const t=(h-SKY[i][0])/(SKY[i+1][0]-SKY[i][0]); return out.set(SKY[i][1]).lerp(_c2.set(SKY[i+1][1]),t); } } return out.set(0x05070f); }
const skyIco=document.getElementById('skyico');
function applyTime(){
  const hh=new Date(nowMs()); const h= dayOv==='day'?13: dayOv==='night'?23: hh.getHours()+hh.getMinutes()/60;
  const elev=Math.sin((h-6)/24*Math.PI*2);          // sun height -1..1
  const day=smooth(-.05,.35,elev);
  skyColor(h,_c1); scene.background.copy(_c1); scene.fog.color.copy(_c1);
  const ang=(h-6)/12*Math.PI;                         // sun arc east->west
  sun.position.set(Math.cos(ang)*50, Math.max(6,Math.sin(ang)*50), -18);
  sun.target.position.set(0,0,0);
  sun.intensity = 2.6*day + .35*(1-day);
  sun.color.set(day>.5?0xfff1d6:(elev>-.1?0xffb27a:0x7f95ff));
  hemi.intensity = .25+.75*day;
  hemi.color.set(day>.4?0xcfe6ff:0x6f86c8);
  renderer.toneMappingExposure = lerp(.95,1.2,1-day);
  const night=1-day;
  ZONES.forEach(z=>{ z.light.intensity = lerp(7,60,night)*(z.lightK??1); });   // lightK: dims offices nobody works in
  cityMats.forEach(m=>m.emissiveIntensity = night*1.3);
  bloom.strength = lerp(.28,.8,night);
  M.glass.opacity = lerp(.12,.2,night);
  skyIco.textContent = day>.55 ? '☀️' : (elev>-.15 ? (h<12?'🌅':'🌇') : '🌙');
}



/* ============================================================
   Task control (assign work from the 3D office)
   ============================================================ */
const modalBg=document.getElementById('modalbg'), modalBox=document.getElementById('modalbox'), banner=document.getElementById('banner');
let pendingAssign=null;
const errText = e => typeof e==='string'?e:(e&&(e.message||e.error))?(typeof (e.message||e.error)==='string'?(e.message||e.error):JSON.stringify(e.message||e.error)):JSON.stringify(e);
async function api(method,path,body){
  const r=await fetch('/api'+path,{method,headers:{'Content-Type':'application/json','X-Sim3D-Confirm':'1'},body:body?JSON.stringify(body):undefined});
  let j=null; try{ j=await r.json(); }catch(e){}
  if(!r.ok) throw new Error(errText(j&&(j.error||j.message))||('HTTP '+r.status));
  return j;
}
function openModal(html){ modalBox.innerHTML=html; modalBg.classList.add('show'); }
function closeModal(){ modalBg.classList.remove('show'); modalBox.innerHTML=''; }
modalBg.addEventListener('pointerdown',e=>{ if(e.target===modalBg) closeModal(); });
function askConfirm(html, okLabel='Xác nhận'){
  return new Promise(res=>{
    const w=document.createElement('div'); w.id='confirm';
    w.innerHTML=`<div class="glass"><p>${html}</p><small>Thao tác này ghi trực tiếp vào Paperclip.</small><div class="btns" style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px"><button id="c-no">Huỷ</button><button class="danger" id="c-ok">${okLabel}</button></div></div>`;
    document.body.appendChild(w);
    const done=v=>{ w.remove(); res(v); };
    w.querySelector('#c-no').onclick=()=>done(false); w.querySelector('#c-ok').onclick=()=>done(true);
    w.addEventListener('pointerdown',e=>{ if(e.target===w) done(false); });
  });
}
const agentOpts = sel => ZONES.flatMap(z=>z.people.map(e=>e)).map(e=>`<option value="${e.id}" ${e.id===sel?'selected':''}>${esc(e.data.name)} · ${esc(e.zone.name)}</option>`).join('');
const STATUSES={backlog:'Backlog',todo:'Cần làm',in_progress:'Đang làm',in_review:'Đang review',blocked:'Bị chặn',done:'Xong',cancelled:'Huỷ'};
const statusOpts = sel => Object.entries(STATUSES).map(([k,v])=>`<option value="${k}" ${k===sel?'selected':''}>${v}</option>`).join('');
async function afterWrite(msg, color){ if(msg) log(msg,color||0x5be7ff); slowAt=0; await loop(); refreshUI(); pollChat(); }
const nameOf = id => (agentById(id)||{}).name||'—';

async function doAssign(issue, agent){
  const cur=issue.assigneeAgentId?agentById(issue.assigneeAgentId):null;
  const ok=await askConfirm(`Giao <b>${esc(issue.identifier)}</b> “${esc((issue.title||'').slice(0,80))}” cho <b>${esc(agent.data.name)}</b>?${cur&&cur.id!==agent.id?`<br>Hiện đang giao cho ${esc(cur.name)}.`:''}<br><small>Agent sẽ được đánh thức và có thể phát sinh chi phí.</small>`,'Giao việc');
  if(!ok) return;
  const body={assigneeAgentId:agent.id}; if(['done','cancelled'].includes(issue.status)){ body.status='todo'; body.reopen=true; }
  try{ await api('PATCH','/issues/'+issue.id,body); toast('✅ Đã giao '+issue.identifier,'cho '+agent.data.name);
    await afterWrite(`🖱 Bạn giao <b>${esc(issue.identifier)}</b> cho <b>${esc(agent.data.name)}</b>`, agent.zone.color); }
  catch(e){ toast('❌ Không giao được',errText(e.message)); }
}

function openCreateModal(agentId){
  const projs=DATA.projects, defProj=projFilter||(projs[0]&&projs[0].id)||'';
  openModal(`<h3>＋ Giao việc mới</h3><div class="sub">Tạo issue và giao cho một agent.</div>
    <label>Tiêu đề<input id="m-title" placeholder="VD: Viết test cho module Báo cáo"></label>
    <label>Mô tả / yêu cầu<textarea id="m-desc" rows="4" placeholder="Agent sẽ đọc phần này để làm việc"></textarea></label>
    <div class="two"><label>Dự án<select id="m-proj">${projs.map(p=>`<option value="${p.id}" ${p.id===defProj?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label>
    <label>Ưu tiên<select id="m-pri"><option value="medium">Trung bình</option><option value="high">Cao</option><option value="critical">Khẩn cấp</option><option value="low">Thấp</option></select></label></div>
    <label>Giao cho<select id="m-ag">${agentOpts(agentId)}</select></label>
    <div class="err" id="m-err"></div>
    <div class="btns"><button id="m-cancel">Huỷ</button><button class="on" id="m-ok">Giao việc</button></div>`);
  const $=id=>modalBox.querySelector(id); $('#m-title').focus();
  $('#m-cancel').onclick=closeModal;
  $('#m-ok').onclick=async()=>{
    const title=$('#m-title').value.trim(), description=$('#m-desc').value.trim(), ag=agents.get($('#m-ag').value), proj=DATA.projects.find(p=>p.id===$('#m-proj').value);
    if(!title&&!description){ $('#m-err').textContent='Nhập tiêu đề hoặc mô tả.'; return; }
    if(!ag){ $('#m-err').textContent='Chọn agent.'; return; }
    const ok=await askConfirm(`Tạo issue “${esc(title||description.slice(0,60))}”${proj?` trong dự án <b>${esc(proj.name)}</b>`:''} và giao cho <b>${esc(ag.data.name)}</b>?<br><small>Agent sẽ được đánh thức và có thể phát sinh chi phí.</small>`,'Tạo & giao');
    if(!ok) return;
    const body={status:'todo',priority:$('#m-pri').value,assigneeAgentId:ag.id}; if(title)body.title=title; if(description)body.description=description; if(proj)body.projectId=proj.id;
    try{ const r=await api('POST','/companies/'+companyId+'/issues',body); closeModal(); toast('✅ Đã tạo '+((r&&r.identifier)||'issue'),'giao cho '+ag.data.name);
      await afterWrite(`➕ Bạn tạo ${esc((r&&r.identifier)||'issue mới')} và giao cho <b>${esc(ag.data.name)}</b>`, ag.zone.color); }
    catch(e){ $('#m-err').textContent='Lỗi: '+errText(e.message); }
  };
}

function openIssueModal(issue){
  const pr=projectOf(issue), as=agentById(issue.assigneeAgentId);
  openModal(`<h3>${esc(issue.identifier)} · ${esc(issue.title||'')}</h3><div class="sub">${pr?esc(pr.name)+' · ':''}${STATUSES[issue.status]||issue.status} · ${as?'giao cho '+esc(as.name):'chưa giao ai'}</div>
    <div class="inl"><label>Trạng thái<select id="m-st">${statusOpts(issue.status)}</select></label><button id="m-st-ok">Đổi</button></div>
    <div class="inl"><label>Giao cho<select id="m-ag">${agentOpts(issue.assigneeAgentId)}</select></label><button id="m-ag-ok">Giao lại</button><button id="m-pick" title="Chọn agent bằng cách click trong 3D">🖱 Chọn trong 3D</button></div>
    <div class="sec"><label>Chỉ đạo / bình luận<textarea id="m-cm" rows="3" placeholder="Gửi tin nhắn cho agent qua issue này"></textarea></label></div>
    <div class="err" id="m-err"></div>
    <div class="btns"><button id="m-wake" ${as?'':'disabled'}>⚡ Đánh thức agent</button><button id="m-cm-ok">Gửi bình luận</button><button id="m-close">Đóng</button></div>`);
  const $=id=>modalBox.querySelector(id), fail=e=>{ $('#m-err').textContent='Lỗi: '+errText(e.message); };
  $('#m-close').onclick=closeModal;
  $('#m-st-ok').onclick=async()=>{ const st=$('#m-st').value; if(st===issue.status) return;
    if(!await askConfirm(`Đổi trạng thái <b>${esc(issue.identifier)}</b> sang <b>${STATUSES[st]}</b>?`)) return;
    try{ await api('PATCH','/issues/'+issue.id,{status:st}); closeModal(); toast('✅ Đã đổi trạng thái',issue.identifier+' → '+STATUSES[st]); await afterWrite(`🔄 Bạn đổi ${esc(issue.identifier)} → ${STATUSES[st]}`); }catch(e){ fail(e); } };
  $('#m-ag-ok').onclick=async()=>{ const ag=agents.get($('#m-ag').value); if(!ag||ag.id===issue.assigneeAgentId) return; closeModal(); doAssign(issue,ag); };
  $('#m-pick').onclick=()=>{ closeModal(); pendingAssign=issue; banner.textContent=`🖱 Click vào một agent trong 3D để giao ${issue.identifier} (Esc để huỷ)`; banner.classList.add('show'); };
  $('#m-cm-ok').onclick=async()=>{ const body=$('#m-cm').value.trim(); if(!body){ $('#m-err').textContent='Nhập nội dung.'; return; }
    if(!await askConfirm(`Gửi bình luận vào <b>${esc(issue.identifier)}</b>?<br><small>“${esc(body.slice(0,120))}”</small>`,'Gửi')) return;
    try{ await api('POST','/issues/'+issue.id+'/comments',{body}); closeModal(); toast('💬 Đã gửi',issue.identifier); await afterWrite(`💬 Bạn bình luận ở ${esc(issue.identifier)}`); }catch(e){ fail(e); } };
  $('#m-wake').onclick=async()=>{ if(!as) return;
    if(!await askConfirm(`Đánh thức <b>${esc(as.name)}</b> ngay bây giờ?<br><small>Agent sẽ bắt đầu một lượt chạy và có thể phát sinh chi phí.</small>`,'Đánh thức')) return;
    try{ await api('POST','/agents/'+as.id+'/wakeup',{source:'on_demand',triggerDetail:'manual',reason:'Đánh thức từ mô phỏng 3D cho '+issue.identifier,forceFreshSession:false}); closeModal(); toast('⚡ Đã đánh thức',as.name); await afterWrite(`⚡ Bạn đánh thức <b>${esc(as.name)}</b>`,0xffc24b); }catch(e){ fail(e); } };
}

document.getElementById('newtask').onclick=()=>openCreateModal(selEmp&&selEmp.id);
addEventListener('keydown',ev=>{ if(ev.code==='Escape'){ if(pendingAssign){ pendingAssign=null; banner.classList.remove('show'); } else if(modalBg.classList.contains('show')) closeModal(); } });
// Space shortcut must not fire while typing in a form
modalBox.addEventListener('keydown',ev=>ev.stopPropagation());

/* issue board in the left panel (draggable) */
let lastIssSig='';
function renderIssueList(){
  const box=document.getElementById('isslist');
  const rank={blocked:0,in_progress:1,in_review:2,todo:3,backlog:4};
  const list=curIssues().filter(isOpen).sort((a,b)=>(rank[a.status]??9)-(rank[b.status]??9));
  const sig=projFilter+'|'+list.map(i=>i.id+i.status+(i.assigneeAgentId||'')+i.title).join(',');
  if(sig===lastIssSig) return; lastIssSig=sig; box.innerHTML='';
  if(!list.length){ box.innerHTML='<div style="color:var(--mut);font-size:12px;padding:6px">Không có issue mở.</div>'; return; }
  list.forEach(is=>{ const d=document.createElement('div'); d.className='iss'; d.draggable=true;
    d.innerHTML=`<span class="sd" style="background:${issCol(is.status)}"></span><b>${esc(is.identifier)}</b><span class="t">${esc((is.title||'').replace(/^\[[^\]]+\]\s*/,''))}</span><span class="who">${esc(is.assigneeAgentId?nameOf(is.assigneeAgentId):'chưa giao')}</span>`;
    d.title=is.title;
    d.onclick=()=>openIssueModal(is);
    d.addEventListener('dragstart',ev=>{ ev.dataTransfer.setData('text/plain',is.id); ev.dataTransfer.effectAllowed='move'; document.body.classList.add('dragging'); });
    d.addEventListener('dragend',()=>document.body.classList.remove('dragging'));
    box.appendChild(d); });
}
/* drop an issue onto an agent in the 3D scene */
renderer.domElement.addEventListener('dragover',ev=>{ ev.preventDefault(); mouse.set(ev.clientX/innerWidth*2-1, -(ev.clientY/innerHeight)*2+1); });
renderer.domElement.addEventListener('drop',ev=>{
  ev.preventDefault(); document.body.classList.remove('dragging');
  mouse.set(ev.clientX/innerWidth*2-1, -(ev.clientY/innerHeight)*2+1); pickScene();
  const is=issueById(ev.dataTransfer.getData('text/plain'));
  if(is&&hoverEmp) doAssign(is,hoverEmp); else toast('Thả lên một agent','để giao '+(is?is.identifier:'issue'));
});

/* ============================================================
   Live polling
   ============================================================ */
const connEl=document.getElementById('conn');
function showConn(){ connEl.className='pill '+(DATA.ok?'on':'off'); connEl.textContent=DATA.ok?(replay?'● Phát lại lịch sử':'● Live · Paperclip'):'● Mất kết nối Paperclip'; document.getElementById('company').textContent=DATA.projects.length+' dự án · '+agents.size+' agent'; updateBrand(); }
async function loop(){
  const was=DATA.ok; const ok=await pollOnce();
  if(ok){ syncAgents(); if(!replay){ setModes(Date.now()); ingestActivity(false); } if(!was) log('🔌 Đã kết nối Paperclip',0x4ade80); }
  else if(was) log('🔌 Mất kết nối Paperclip — giữ dữ liệu cuối',0xff7a59);
  showConn();
}
setInterval(loop,4000);

/* ============================================================
   Main loop
   ============================================================ */
let last=performance.now(), uiT=0, scrT=0, elapsed=0, ledT=0, modeT=0;
const dummyC=new THREE.Color();
function nowMs(){ return replay?replay.vt:Date.now(); }
function frame(now){
  requestAnimationFrame(frame);
  const dt=Math.min(.05,(now-last)/1000); last=now; elapsed+=dt;
  if(replay){ replay.vt+=dt*1000*replay.speed; modeT+=dt; if(modeT>.25){ modeT=0; setModes(replay.vt); } if(replay.vt>=replay.t1) setMode('live'); }
  else { modeT+=dt; if(modeT>1){ modeT=0; setModes(Date.now()); } }
  for(const e of agents.values()) updateEmp(e,dt,elapsed);

  const ms=nowMs(), d=new Date(ms);
  document.getElementById('time').textContent=d.toTimeString().slice(0,8);
  document.getElementById('date').textContent=d.toLocaleDateString('vi-VN',{weekday:'long',day:'numeric',month:'numeric'})+(replay?' · phát lại':' · trực tiếp');
  applyTime();

  // desk screens light up only for an owner who is seated and running; empty offices dim their light
  for(const z of ZONES){
    let active=0;
    for(const sp of z.deskSpots){
      const o=sp.owner, on=!!(o && o.mode==='running' && o.loc===sp && o.state!=='walk');
      if(on) active++;
      sp.glow=lerp(sp.glow,on?1:0,Math.min(1,dt*3));
      sp.screenMat.color.copy(z.col).lerp(_c1.set(0x0a1224),.5).multiplyScalar(.05+sp.glow*(1.2+.35*Math.sin(elapsed*1.3+sp.ph)));
    }
    if(z.kind==='office' && !z.lobby) z.lightK=lerp(z.lightK??1, active?1:.25, Math.min(1,dt*2));
  }
  scrT+=dt; if(scrT>.12){ scrT=0; const s=screens[(Math.floor(elapsed*8))%screens.length]; s.draw(s,elapsed+s.seed); s.tex.needsUpdate=true; }
  ledT+=dt; if(ledT>.15){ ledT=0; ledInst.forEach(l=>{ for(let i=0;i<4;i++){ const k=Math.floor(Math.random()*40); const r=Math.random(); l.setColorAt(k, dummyC.set(r<.7?0x35ff8f:(r<.9?0x5be7ff:0xffb347)).multiplyScalar(r<.05?0.1:2)); } l.instanceColor.needsUpdate=true; }); }
  { const p=motes.pos; for(let i=0;i<motes.sp.length;i++){ p[i*3+1]+=motes.sp[i]*dt*.5; if(p[i*3+1]>5.5)p[i*3+1]=.4; p[i*3]+=Math.sin(elapsed*.3+i)*dt*.04; } motes.p.geometry.attributes.position.needsUpdate=true; }

  pickScene();
  ZONES.forEach(z=>{ const on=(z===hoverZone||z===selZone); z.mat.emissiveIntensity=lerp(z.mat.emissiveIntensity,on?.16:0,.15); z.labelEl.classList.toggle('hot',z===selZone); });
  if(hoverEmp){ nameLabel.visible=true; nameLabel.position.copy(hoverEmp.root.position).add(_v.set(0,2.5,0)); nameLabelEl.textContent=`${hoverEmp.data.name} · ${MODE[hoverEmp.mode||'idle'].t}`; }
  else nameLabel.visible=false;

  if(camAnim){ const k=clamp((performance.now()-camAnim.s)/camAnim.dur,0,1), e=k<.5?4*k*k*k:1-Math.pow(-2*k+2,3)/2;
    camera.position.lerpVectors(camAnim.p0,camAnim.p1,e); controls.target.lerpVectors(camAnim.t0,camAnim.t1,e); if(k>=1)camAnim=null; }
  else if(follow){ const tgt=_v.copy(follow.root.position).setY(1); const dlt=tgt.clone().sub(controls.target).multiplyScalar(.12); controls.target.add(dlt); camera.position.add(dlt); }
  if(tourOn && !camAnim){ tourT+=dt; if(tourT>6.5||tourT===dt){ tourT=.001; const z=ZONES.filter(q=>q.kind==='office'&&q.people.length)[tourI++%ZONES.filter(q=>q.kind==='office'&&q.people.length).length]; if(z){ selZone=z; selEmp=null; follow=null; focusZone(z); renderPanel(); markDept(); } } }
  controls.update();
  document.body.classList.toggle('far', camera.position.distanceTo(controls.target)>48);

  uiT+=dt; if(uiT>.25){ uiT=0; refreshUI(); }
  if(fx) composer.render(); else renderer.render(scene,camera);
  labelRenderer.render(scene,camera);
}

addEventListener('resize',()=>{
  camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth,innerHeight); composer.setSize(innerWidth,innerHeight); labelRenderer.setSize(innerWidth,innerHeight);
});

// Kick off
syncAgents(); setModes(Date.now(),true); ingestActivity(true); showConn(); pollChat();
log(DATA.ok?`🏢 Đã tải ${agents.size} agent từ Paperclip`:'🔌 Chưa kết nối được Paperclip (đang thử lại…)', DATA.ok?0x5be7ff:0xff7a59);
{const c=CAMS.iso(); camera.position.copy(c[0]); controls.target.copy(c[1]);}
applyTime(); refreshUI();
requestAnimationFrame(frame);
setTimeout(()=>document.getElementById('loading').classList.add('off'),500);
window.__sim = {setProject, say, DATA, agents, ZONES, camera, controls, selectZone, selectEmp, setMode, get replay(){return replay;}};
