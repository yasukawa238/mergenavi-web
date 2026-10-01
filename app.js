import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./supabase-config.js";
const supabase=createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY);
const $=id=>document.getElementById(id);
const map=L.map("map").setView([35.2281,138.8994],16);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:20,attribution:"&copy; OpenStreetMap contributors"}).addTo(map);
const clientId=crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2);
let channel=null,joined=false,mode=null,watchId=null,mergePoint=null,mergeMarker=null,currentPos=null,currentMarker=null;
let drawPoints=[],routes={main:[],merge:[]},routeLayers={main:null,merge:null},previewLayer=null,telemetry={main:null,merge:null},speedEMA=null,lastGeo=null,lastCloudRx=0,lastGpsTimestamp=0;

function toast(msg){const t=$("toast");t.textContent=msg;t.classList.add("show");clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.classList.remove("show"),1800)}
function randomSession(){const c="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";let s="MN";for(let i=0;i<5;i++)s+=c[Math.floor(Math.random()*c.length)];return s}
function sanitizeSession(s){return s.toUpperCase().replace(/[^A-Z0-9_-]/g,"").slice(0,20)}
function role(){return $("role").value}
function sessionId(){return sanitizeSession($("sessionId").value.trim())}
$("sessionId").value=randomSession();
const params=new URLSearchParams(location.search);if(params.get("session"))$("sessionId").value=sanitizeSession(params.get("session"));
$("newSessionBtn").onclick=()=>{$("sessionId").value=randomSession()};

async function leaveChannel(){if(channel){try{await channel.untrack()}catch{};try{await supabase.removeChannel(channel)}catch{};channel=null}joined=false}

$("joinBtn").onclick=async()=>{
 const sid=sessionId(); if(!sid)return alert("Session IDを入力してください");
 await leaveChannel(); $("cloudBadge").textContent="接続中..."; $("cloudBadge").className="badge wait";
 channel=supabase.channel(`mergenavi:${sid}`,{config:{broadcast:{self:false,ack:true},presence:{key:clientId}}});
 channel
 .on("broadcast",{event:"state"},({payload})=>{lastCloudRx=Date.now();applyRemoteState(payload)})
 .on("broadcast",{event:"telemetry"},({payload})=>{lastCloudRx=Date.now();if(payload?.role&&payload?.data){telemetry[payload.role]=payload.data;refreshDashboard()}})
 .on("broadcast",{event:"mergePoint"},({payload})=>{lastCloudRx=Date.now();if(payload?.point)setMergePoint(payload.point,false)})
 .on("broadcast",{event:"route"},({payload})=>{lastCloudRx=Date.now();if(payload?.role&&Array.isArray(payload?.points))setRoute(payload.role,payload.points,false)})
 .on("broadcast",{event:"requestState"},async()=>{lastCloudRx=Date.now();if(joined)await sendState()})
 .on("presence",{event:"sync"},updatePresenceText)
 .on("presence",{event:"join"},updatePresenceText)
 .on("presence",{event:"leave"},updatePresenceText)
 .subscribe(async status=>{
   if(status==="SUBSCRIBED"){joined=true;$("cloudBadge").textContent="Realtime接続";$("cloudBadge").className="badge on";await channel.track({clientId,role:role(),joinedAt:Date.now()});await sendBroadcast("requestState",{from:clientId});toast(`Session ${sid} に接続`)}
   else if(["CHANNEL_ERROR","TIMED_OUT","CLOSED"].includes(status)){joined=false;$("cloudBadge").textContent=status;$("cloudBadge").className="badge off"}
 });
};
$("role").onchange=async()=>{if(joined&&channel)await channel.track({clientId,role:role(),joinedAt:Date.now()})};
$("copyLinkBtn").onclick=async()=>{const u=new URL(location.href);u.searchParams.set("session",sessionId());try{await navigator.clipboard.writeText(u.toString());toast("共有リンクをコピーしました")}catch{prompt("このURLを共有してください",u.toString())}};

async function sendBroadcast(event,payload){if(joined&&channel)await channel.send({type:"broadcast",event,payload})}
async function sendState(){await sendBroadcast("state",{mergePoint,routes,telemetry,sentAt:Date.now(),from:clientId})}
function applyRemoteState(s){if(!s)return;if(s.mergePoint)setMergePoint(s.mergePoint,false);if(Array.isArray(s.routes?.main))setRoute("main",s.routes.main,false);if(Array.isArray(s.routes?.merge))setRoute("merge",s.routes.merge,false);if(s.telemetry?.main)telemetry.main=s.telemetry.main;if(s.telemetry?.merge)telemetry.merge=s.telemetry.merge;refreshDashboard()}
function updatePresenceText(){if(!channel){$("presence").textContent="--";return}const st=channel.presenceState(),rows=[];for(const a of Object.values(st))for(const p of a)rows.push(`${p.role==="main"?"本線車":"合流車"}:${String(p.clientId).slice(0,5)}`);$("presence").textContent=rows.length?rows.join(" / "):"--"}

$("mergePointBtn").onclick=()=>setMode("mergePoint");$("drawRouteBtn").onclick=()=>{drawPoints=[];setMode("drawRoute");previewRoute()};
$("finishRouteBtn").onclick=async()=>{if(drawPoints.length<2)return alert("経路は2点以上設定してください");const r=role();setRoute(r,drawPoints,false);await sendBroadcast("route",{role:r,points:drawPoints,sentAt:Date.now()});drawPoints=[];setMode(null);previewRoute()};
$("undoBtn").onclick=()=>{if(mode==="drawRoute"&&drawPoints.length){drawPoints.pop();previewRoute()}};
$("clearRouteBtn").onclick=async()=>{const r=role();setRoute(r,[],false);await sendBroadcast("route",{role:r,points:[],sentAt:Date.now()})};
function setMode(m){mode=m;["mergePointBtn","drawRouteBtn"].forEach(id=>$(id).classList.remove("active"));if(m==="mergePoint")$("mergePointBtn").classList.add("active");if(m==="drawRoute")$("drawRouteBtn").classList.add("active")}
map.on("click",async e=>{if(mode==="mergePoint"){const p={lat:e.latlng.lat,lng:e.latlng.lng};setMergePoint(p,false);await sendBroadcast("mergePoint",{point:p,sentAt:Date.now()});setMode(null)}else if(mode==="drawRoute"){drawPoints.push({lat:e.latlng.lat,lng:e.latlng.lng});previewRoute()}});
function setMergePoint(p){mergePoint=p;if(mergeMarker)map.removeLayer(mergeMarker);mergeMarker=L.marker([p.lat,p.lng]).addTo(map).bindPopup("合流点")}
function setRoute(r,points){routes[r]=points||[];if(routeLayers[r]){map.removeLayer(routeLayers[r]);routeLayers[r]=null}if(routes[r].length>=2)routeLayers[r]=L.polyline(routes[r].map(p=>[p.lat,p.lng]),{weight:6,opacity:.85,dashArray:r==="main"?null:"10 6"}).addTo(map)}
function previewRoute(){if(previewLayer){map.removeLayer(previewLayer);previewLayer=null}if(drawPoints.length)previewLayer=L.polyline(drawPoints.map(p=>[p.lat,p.lng]),{weight:5,opacity:.7,dashArray:"4 8"}).addTo(map)}

$("gpsBtn").onclick=()=>{if(watchId!=null){navigator.geolocation.clearWatch(watchId);watchId=null;$("gpsBtn").textContent="GPS開始";$("gpsStatus").textContent="停止中";return}if(!navigator.geolocation)return alert("このブラウザは位置情報非対応");watchId=navigator.geolocation.watchPosition(onGeo,e=>$("gpsStatus").textContent=`GPSエラー: ${e.message}`,{enableHighAccuracy:true,maximumAge:0,timeout:10000});$("gpsBtn").textContent="GPS停止";$("gpsStatus").textContent="測位待ち"};
function haversine(a,b){const R=6371000,toRad=x=>x*Math.PI/180,dLat=toRad(b.lat-a.lat),dLng=toRad(b.lng-a.lng),la1=toRad(a.lat),la2=toRad(b.lat);const h=Math.sin(dLat/2)**2+Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2;return 2*R*Math.asin(Math.sqrt(h))}
function deriveSpeed(pos,ts){if(!lastGeo){lastGeo={pos,ts};return null}const dt=(ts-lastGeo.ts)/1000;if(dt<=.2)return null;const v=haversine(lastGeo.pos,pos)/dt;lastGeo={pos,ts};return v}
async function onGeo(g){const pos={lat:g.coords.latitude,lng:g.coords.longitude},ts=g.timestamp||Date.now();lastGpsTimestamp=ts;let sp=Number.isFinite(g.coords.speed)&&g.coords.speed>=0?g.coords.speed:deriveSpeed(pos,ts);if(Number.isFinite(sp))speedEMA=speedEMA==null?sp:(.35*sp+.65*speedEMA);currentPos=pos;if(!currentMarker)currentMarker=L.circleMarker([pos.lat,pos.lng],{radius:8,weight:3}).addTo(map);else currentMarker.setLatLng([pos.lat,pos.lng]);const r=role(),calc=calcForRole(r,pos,speedEMA);$("gpsStatus").textContent=`${pos.lat.toFixed(6)}, ${pos.lng.toFixed(6)}`;$("accuracy").textContent=Number.isFinite(g.coords.accuracy)?`${g.coords.accuracy.toFixed(1)} m`:"-- m";$("speed").textContent=Number.isFinite(speedEMA)?`${(speedEMA*3.6).toFixed(1)} km/h`:"-- km/h";$("remaining").textContent=Number.isFinite(calc.remaining)?`${calc.remaining.toFixed(1)} m`:"-- m";const data={lat:pos.lat,lng:pos.lng,speed:Number.isFinite(speedEMA)?speedEMA:null,accuracy:g.coords.accuracy??null,heading:g.coords.heading??null,timestamp:ts,clientSentAt:Date.now(),remaining:calc.remaining,eta:calc.eta};telemetry[r]=data;await sendBroadcast("telemetry",{role:r,data});refreshDashboard()}
$("centerBtn").onclick=()=>{if(currentPos)map.setView([currentPos.lat,currentPos.lng],18)};

function toXY(p,refLat){const R=6371000,rad=Math.PI/180;return{x:R*(p.lng*rad)*Math.cos(refLat*rad),y:R*(p.lat*rad)}}
function projectPointToRoute(p,route){if(!route||route.length<2)return null;const refLat=p.lat,P=toXY(p,refLat);let cum=0,best=null;for(let i=0;i<route.length-1;i++){const A=toXY(route[i],refLat),B=toXY(route[i+1],refLat),vx=B.x-A.x,vy=B.y-A.y,wx=P.x-A.x,wy=P.y-A.y,len2=vx*vx+vy*vy,t=len2?Math.max(0,Math.min(1,(wx*vx+wy*vy)/len2)):0,qx=A.x+t*vx,qy=A.y+t*vy,dx=P.x-qx,dy=P.y-qy,d2=dx*dx+dy*dy,segLen=Math.sqrt(len2);if(!best||d2<best.d2)best={d2,s:cum+t*segLen};cum+=segLen}return{...best,total:cum}}
function calcForRole(r,pos,sp){const rt=routes[r];if(!mergePoint||!rt||rt.length<2||!pos)return{remaining:null,eta:null};const cur=projectPointToRoute(pos,rt),mer=projectPointToRoute(mergePoint,rt);if(!cur||!mer)return{remaining:null,eta:null};const remaining=Math.max(0,mer.s-cur.s),eta=Number.isFinite(sp)&&sp>.8?remaining/sp:null;return{remaining,eta}}
function renderVehicle(r,data){const e=$(r+"Eta"),d=$(r+"Detail");if(!data){e.textContent="--.- s";d.textContent="待機中";return}e.textContent=Number.isFinite(data.eta)?`${data.eta.toFixed(1)} s`:"--.- s";const kmh=Number.isFinite(data.speed)?data.speed*3.6:null,age=Number.isFinite(data.clientSentAt)?(Date.now()-data.clientSentAt)/1000:null;d.textContent=`${kmh!=null?kmh.toFixed(1)+" km/h":"-- km/h"} / ${Number.isFinite(data.remaining)?data.remaining.toFixed(0)+" m":"-- m"}${age!=null?" / "+age.toFixed(1)+"s old":""}`}
function refreshDashboard(){const m=telemetry.main,g=telemetry.merge;renderVehicle("main",m);renderVehicle("merge",g);const inst=$("instruction"),d=$("delta"),tol=Math.max(.1,parseFloat($("tolerance").value)||.5),control=$("controlRole").value;if(!m||!g||!Number.isFinite(m.eta)||!Number.isFinite(g.eta)){inst.textContent="WAIT";inst.className="instructionText neutral";d.textContent="ΔT --.- s";return}const delta=m.eta-g.eta;d.textContent=`ΔT 本線-合流 = ${delta>=0?"+":""}${delta.toFixed(2)} s`;if(Math.abs(delta)<=tol){inst.textContent="KEEP";inst.className="instructionText ok";return}if(control==="main"){if(delta<0){inst.textContent="本線車 SLOW";inst.className="instructionText slow"}else{inst.textContent="本線車 FAST";inst.className="instructionText fast"}}else{if(delta<0){inst.textContent="合流車 FAST";inst.className="instructionText fast"}else{inst.textContent="合流車 SLOW";inst.className="instructionText slow"}}}
$("tolerance").oninput=refreshDashboard;$("controlRole").onchange=refreshDashboard;
setInterval(()=>{$("cloudAge").textContent=lastCloudRx?`${((Date.now()-lastCloudRx)/1000).toFixed(1)} s`:"-- s";$("age").textContent=lastGpsTimestamp?`${Math.max(0,(Date.now()-lastGpsTimestamp)/1000).toFixed(2)} s`:"-- s";refreshDashboard()},500);
