import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./supabase-config.js";
const APP_VERSION="0.5.3";
const supabase=createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY);
const $=id=>document.getElementById(id);
const map=L.map("map").setView([35.2281,138.8994],16);
const streetLayer=L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{
  maxZoom:20,attribution:"&copy; OpenStreetMap contributors"
});
const aerialLayer=L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",{
  maxZoom:20,attribution:"Tiles &copy; Esri"
});
streetLayer.addTo(map);

L.control.layers({"地図":streetLayer,"航空写真":aerialLayer},null,{position:"topright",collapsed:false}).addTo(map);

// v0.4.7: smartphone route drawing touch handling.
const mapEl=document.getElementById("map");
let touchStartInfo=null;
let lastTouchAddedAt=0;

mapEl.addEventListener("touchstart",(ev)=>{
  if(mode==="drawRoute" && !panMode && ev.touches.length===1){
    const t=ev.touches[0];
    touchStartInfo={x:t.clientX,y:t.clientY,time:Date.now()};
    ev.preventDefault();
  }
},{passive:false});

mapEl.addEventListener("touchmove",(ev)=>{
  if(mode==="drawRoute" && !panMode) ev.preventDefault();
},{passive:false});

mapEl.addEventListener("touchend",(ev)=>{
  if(mode!=="drawRoute" || panMode || !touchStartInfo) return;
  ev.preventDefault();
  const t=ev.changedTouches && ev.changedTouches[0];
  if(!t){touchStartInfo=null;return;}
  const dx=t.clientX-touchStartInfo.x;
  const dy=t.clientY-touchStartInfo.y;
  const dist=Math.hypot(dx,dy);
  const dt=Date.now()-touchStartInfo.time;
  if(dist<=18 && dt<=800){
    const rect=mapEl.getBoundingClientRect();
    const pt=L.point(t.clientX-rect.left,t.clientY-rect.top);
    const latlng=map.containerPointToLatLng(pt);
    drawPoints.push({lat:latlng.lat,lng:latlng.lng});
    previewRoute();
    lastTouchAddedAt=Date.now();
    toast(`経路点 ${drawPoints.length}`);
  }
  touchStartInfo=null;
},{passive:false});

const clientId=crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2);
let channel=null,joined=false,mode=null,panMode=false,watchId=null,mergePoint=null,mergeMarker=null,currentPos=null,currentMarker=null;
let drawPoints=[],routes={main:[],merge:[]},routeLayers={main:null,merge:null},previewLayer=null,telemetry={main:null,merge:null},speedEMA=null,lastGeo=null,lastCloudRx=0,lastGpsTimestamp=0;
let logRecording=false, driveLog=[], logStartedAt=null, lastLogAccepted=null;
let cloudLogs=[];
let wakeLockSentinel=null, wakeLockWanted=false;

function toast(msg){const t=$("toast");t.textContent=msg;t.classList.add("show");clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.classList.remove("show"),1800)}
function randomSession(){const c="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";let s="MN";for(let i=0;i<5;i++)s+=c[Math.floor(Math.random()*c.length)];return s}
function sanitizeSession(s){return s.toUpperCase().replace(/[^A-Z0-9_-]/g,"").slice(0,20)}
function role(){return $("role").value}
function updateRoleTheme(){
  const r=role();
  document.body.classList.toggle("role-main",r==="main");
  document.body.classList.toggle("role-merge",r==="merge");
  const badge=$("roleBadge");
  if(badge){
    badge.textContent=r==="main"?"本線車":"合流車";
    badge.className=`roleBadge ${r}`;
  }
  document.title=`${r==="main"?"本線車":"合流車"} | MergeNavi ${APP_VERSION}`;
}
function isMaster(){ return role()==="main"; }

function updateMasterUi(){
  const master=isMaster();
  const badge=$("masterBadge");
  if(badge){
    badge.textContent=master?"MASTER":"FOLLOWER";
    badge.className=`masterBadge ${master?"master":"follower"}`;
  }
  const banner=$("masterBanner");
  if(banner){
    banner.className=`masterBanner ${master?"master":"follower"}`;
    const main=banner.querySelector(".masterBannerMain");
    const sub=banner.querySelector(".masterBannerSub");
    if(main)main.textContent=master?"MASTER":"FOLLOWER";
    if(sub)sub.textContent=master?"本線車":"合流車";
  }

  for(const el of document.querySelectorAll(".commonSetting")){
    el.disabled=!master;
  }
  for(const el of document.querySelectorAll(".commonSettingAction")){
    el.disabled=!master;
  }

  const note=$("commonSyncNote");
  if(note){
    note.innerHTML=master
      ? 'この端末が <b>MASTER</b> です。共通設定を合流車へ配信します。'
      : '共通設定は <b>本線車 MASTER</b> から自動反映されます。';
  }
}


async function requestWakeLock(){
  if(!("wakeLock" in navigator)){
    const btn=$("wakeLockBtn");
    if(btn){
      btn.textContent="画面ロック防止 非対応";
      btn.classList.remove("wakeOn");
      btn.classList.add("wakeUnsupported");
    }
    wakeLockWanted=false;
    return;
  }
  try{
    wakeLockSentinel=await navigator.wakeLock.request("screen");
    const btn=$("wakeLockBtn");
    if(btn){
      btn.textContent="画面ロック防止 ON";
      btn.classList.add("wakeOn");
      btn.classList.remove("wakeUnsupported");
    }
    wakeLockSentinel.addEventListener("release",()=>{
      wakeLockSentinel=null;
      const b=$("wakeLockBtn");
      if(b && !wakeLockWanted){
        b.textContent="画面ロック防止 OFF";
        b.classList.remove("wakeOn");
      }
    });
  }catch(err){
    console.warn("Wake Lock request failed",err);
    const btn=$("wakeLockBtn");
    if(btn){
      btn.textContent="画面ロック防止 取得失敗";
      btn.classList.remove("wakeOn");
    }
  }
}

async function releaseWakeLock(){
  wakeLockWanted=false;
  if(wakeLockSentinel){
    try{await wakeLockSentinel.release();}catch{}
    wakeLockSentinel=null;
  }
  const btn=$("wakeLockBtn");
  if(btn){
    btn.textContent="画面ロック防止 OFF";
    btn.classList.remove("wakeOn");
  }
}

function collectCommonSettings(){
  return {
    controlRole:$("controlRole").value,
    tolerance:parseFloat($("tolerance").value),
    testMode:$("testMode").checked,
    testMainSpeed:parseFloat($("testMainSpeed").value),
    testMainRemaining:parseFloat($("testMainRemaining").value),
    testMergeSpeed:parseFloat($("testMergeSpeed").value),
    testMergeRemaining:parseFloat($("testMergeRemaining").value),
    mergePoint
  };
}

function applyCommonSettings(s){
  if(!s)return;
  if(s.controlRole!=null)$("controlRole").value=s.controlRole;
  if(Number.isFinite(s.tolerance))$("tolerance").value=s.tolerance;
  if(typeof s.testMode==="boolean")$("testMode").checked=s.testMode;
  if(Number.isFinite(s.testMainSpeed))$("testMainSpeed").value=s.testMainSpeed;
  if(Number.isFinite(s.testMainRemaining))$("testMainRemaining").value=s.testMainRemaining;
  if(Number.isFinite(s.testMergeSpeed))$("testMergeSpeed").value=s.testMergeSpeed;
  if(Number.isFinite(s.testMergeRemaining))$("testMergeRemaining").value=s.testMergeRemaining;
  if(s.mergePoint)setMergePoint(s.mergePoint,false);
  refreshDashboard();
}

async function publishCommonSettings(){
  if(!isMaster())return;
  await sendBroadcast("commonSettings",{
    settings:collectCommonSettings(),
    sentAt:Date.now(),
    from:clientId
  });
}

function sessionId(){return sanitizeSession($("sessionId").value.trim())}
$("sessionId").value=randomSession();
const params=new URLSearchParams(location.search);if(params.get("session"))$("sessionId").value=sanitizeSession(params.get("session"));
updateRoleTheme();
updateMasterUi();
$("newSessionBtn").onclick=()=>{$("sessionId").value=randomSession()};
$("copySessionBtn").onclick=async()=>{
  const sid=sessionId();
  if(!sid)return alert("Session IDを入力してください");
  try{
    await navigator.clipboard.writeText(sid);
    toast(`Session ID「${sid}」をコピーしました`);
  }catch{
    prompt("このSession IDをコピーしてください",sid);
  }
};


async function leaveChannel(){
  if(channel){
    try{await channel.untrack()}catch{}
    try{await supabase.removeChannel(channel)}catch{}
    channel=null;
  }
  joined=false;
  updatePresenceText();
}

$("joinBtn").onclick=async()=>{
 const sid=sessionId(); if(!sid)return alert("Session IDを入力してください");
 await leaveChannel(); $("cloudBadge").textContent="接続中..."; $("cloudBadge").className="badge wait";
 channel=supabase.channel(`mergenavi:${sid}`,{config:{broadcast:{self:false,ack:true},presence:{key:clientId}}});
 channel
 .on("broadcast",{event:"state"},({payload})=>{lastCloudRx=Date.now();applyRemoteState(payload)})
 .on("broadcast",{event:"telemetry"},({payload})=>{lastCloudRx=Date.now();if(payload?.role && Object.prototype.hasOwnProperty.call(payload,"data")){telemetry[payload.role]=payload.data;refreshDashboard()}})
 .on("broadcast",{event:"mergePoint"},({payload})=>{lastCloudRx=Date.now();if(!isMaster()&&payload?.point)setMergePoint(payload.point,false)})
 .on("broadcast",{event:"route"},({payload})=>{lastCloudRx=Date.now();if(payload?.role&&Array.isArray(payload?.points))setRoute(payload.role,payload.points,false)})
 .on("broadcast",{event:"commonSettings"},({payload})=>{
   lastCloudRx=Date.now();
   if(!isMaster() && payload?.settings)applyCommonSettings(payload.settings);
 })
 .on("broadcast",{event:"requestState"},async()=>{lastCloudRx=Date.now();if(joined&&isMaster())await sendState()})
 .on("presence",{event:"sync"},updatePresenceText)
 .on("presence",{event:"join"},updatePresenceText)
 .on("presence",{event:"leave"},updatePresenceText)
 .subscribe(async status=>{
   if(status==="SUBSCRIBED"){joined=true;$("cloudBadge").textContent="Realtime接続";$("cloudBadge").className="badge on";await channel.track({clientId,role:role(),joinedAt:Date.now()});
    updatePresenceText();
   if(isMaster()){
     await publishCommonSettings();
     await sendState();
   }else{
     await sendBroadcast("requestState",{from:clientId});
   }
   if($("testMode").checked && isMaster())await publishIndoorTest();
   toast(`Session ${sid} に接続`)}
   else if(["CHANNEL_ERROR","TIMED_OUT","CLOSED"].includes(status)){joined=false;$("cloudBadge").textContent=status;$("cloudBadge").className="badge off"}
 });
};
$("role").onchange=async()=>{
  updateRoleTheme();
  updateMasterUi();
  clearCloudLogList();
  if(joined&&channel){
    await channel.track({clientId,role:role(),joinedAt:Date.now()});
    if(isMaster()){
      await publishCommonSettings();
      await sendState();
    }else{
      await sendBroadcast("requestState",{from:clientId});
    }
  }
  if($("testMode").checked && isMaster())await publishIndoorTest();
};
$("copyLinkBtn").onclick=async()=>{const u=new URL(location.href);u.searchParams.set("session",sessionId());try{await navigator.clipboard.writeText(u.toString());toast("共有リンクをコピーしました")}catch{prompt("このURLを共有してください",u.toString())}};

async function sendBroadcast(event,payload){if(joined&&channel)await channel.send({type:"broadcast",event,payload})}
async function sendState(){
  if(!isMaster())return;
  await sendBroadcast("state",{
    mergePoint,
    routes,
    telemetry,
    commonSettings:collectCommonSettings(),
    sentAt:Date.now(),
    from:clientId
  });
}
function applyRemoteState(s){
  if(!s)return;
  if(!isMaster() && s.commonSettings)applyCommonSettings(s.commonSettings);
  else if(s.mergePoint)setMergePoint(s.mergePoint,false);
  if(Array.isArray(s.routes?.main))setRoute("main",s.routes.main,false);
  if(Array.isArray(s.routes?.merge))setRoute("merge",s.routes.merge,false);
  if(s.telemetry?.main)telemetry.main=s.telemetry.main;
  if(s.telemetry?.merge)telemetry.merge=s.telemetry.merge;
  refreshDashboard();
}
function updatePresenceText(){
  const box=$("presence");
  const count=$("presenceCount");
  if(!box)return;

  if(!channel || !joined){
    box.textContent="未接続";
    if(count)count.textContent="0台";
    return;
  }

  const st=channel.presenceState();
  const rows=[];
  for(const arr of Object.values(st)){
    for(const p of arr){
      if(!p?.clientId)continue;
      rows.push(p);
    }
  }

  if(count)count.textContent=`${rows.length}台`;

  if(!rows.length){
    box.textContent="接続端末を確認中...";
    return;
  }

  box.innerHTML="";
  rows
    .sort((a,b)=>(a.role==="main"?0:1)-(b.role==="main"?0:1))
    .forEach(p=>{
      const chip=document.createElement("span");
      const r=p.role==="main"?"main":"merge";
      chip.className=`presenceChip ${r}${p.clientId===clientId?" self":""}`;
      chip.textContent=`${r==="main"?"本線車":"合流車"} · ${String(p.clientId).slice(0,5)}`;
      box.appendChild(chip);
    });
}

$("mergePointBtn").onclick=()=>setMode("mergePoint");
$("drawRouteBtn").onclick=()=>{drawPoints=[];panMode=false;setMode("drawRoute");previewRoute()};
$("panModeBtn").onclick=()=>{
  panMode=!panMode;
  $("panModeBtn").classList.toggle("active",panMode);
  if(mode==="drawRoute"){
    if(panMode){map.dragging.enable();toast("地図移動モード")}
    else{map.dragging.disable();toast("経路描画モード")}
  }
  updateTouchLock();
};
$("finishRouteBtn").onclick=async()=>{if(drawPoints.length<2)return alert("経路は2点以上設定してください");const r=role();setRoute(r,drawPoints,false);await sendBroadcast("route",{role:r,points:drawPoints,sentAt:Date.now()});drawPoints=[];setMode(null);previewRoute()};
$("undoBtn").onclick=()=>{if(mode==="drawRoute"&&drawPoints.length){drawPoints.pop();previewRoute()}};
$("clearRouteBtn").onclick=async()=>{const r=role();setRoute(r,[],false);await sendBroadcast("route",{role:r,points:[],sentAt:Date.now()})};
function updateTouchLock(){
  document.body.classList.toggle("route-drawing", mode==="drawRoute" && !panMode);
  document.body.classList.toggle("route-panning", mode==="drawRoute" && panMode);
}
function setMode(m){
  mode=m;
  ["mergePointBtn","drawRouteBtn"].forEach(id=>$(id).classList.remove("active"));
  if(m==="mergePoint"){
    $("mergePointBtn").classList.add("active");
    map.dragging.enable();
  }else if(m==="drawRoute"){
    $("drawRouteBtn").classList.add("active");
    if(panMode)map.dragging.enable();else map.dragging.disable();
  }else{
    map.dragging.enable();
    panMode=false;
    $("panModeBtn").classList.remove("active");
  }
  updateTouchLock();
}
map.on("click",async e=>{
  if(mode==="mergePoint"){
    if(!isMaster()){toast("合流点は本線車MASTERで設定します");setMode(null);return;}
    const p={lat:e.latlng.lat,lng:e.latlng.lng};
    setMergePoint(p,false);
    await sendBroadcast("mergePoint",{point:p,sentAt:Date.now()});
    await publishCommonSettings();
    setMode(null);
  }else if(mode==="drawRoute" && !panMode){
    if(Date.now()-lastTouchAddedAt<700) return;
    drawPoints.push({lat:e.latlng.lat,lng:e.latlng.lng});
    previewRoute();
    toast(`経路点 ${drawPoints.length}`);
  }
});
function setMergePoint(p){mergePoint=p;if(mergeMarker)map.removeLayer(mergeMarker);mergeMarker=L.marker([p.lat,p.lng]).addTo(map).bindPopup("合流点")}
function setRoute(r,points){routes[r]=points||[];if(routeLayers[r]){map.removeLayer(routeLayers[r]);routeLayers[r]=null}if(routes[r].length>=2)routeLayers[r]=L.polyline(routes[r].map(p=>[p.lat,p.lng]),{weight:6,opacity:.85,dashArray:r==="main"?null:"10 6"}).addTo(map)}
function previewRoute(){if(previewLayer){map.removeLayer(previewLayer);previewLayer=null}if(drawPoints.length)previewLayer=L.polyline(drawPoints.map(p=>[p.lat,p.lng]),{weight:5,opacity:.7,dashArray:"4 8"}).addTo(map)}



function makeDefaultLogName(){
  const d=new Date();
  const pad=n=>String(n).padStart(2,"0");
  const dt=`${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const roleText=role()==="main"?"本線":"合流";
  return `${roleText}_${dt}`;
}

function updateLogUi(){
  $("logCount").textContent=String(driveLog.length);
  $("logState").textContent=logRecording?"記録中":"停止中";
  $("logState").className=logRecording?"recording":"";
  const dur=logStartedAt?((Date.now()-logStartedAt)/1000):0;
  $("logDuration").textContent=`${dur.toFixed(1)} s`;
}

function csvEscape(v){
  const s=(v??"").toString();
  return `"${s.replaceAll('"','""')}"`;
}

function downloadCsv(){
  if(!driveLog.length){alert("ログがありません");return}
  const cols=["timestamp","iso_time","role","lat","lng","speed_kmh","accuracy_m","heading_deg","remaining_m","eta_s","other_eta_s","delta_t_s","cloud_age_s","session_id"];
  const lines=[cols.join(",")];
  for(const p of driveLog){
    lines.push([
      p.timestamp,
      p.iso_time,
      p.role,
      p.lat,
      p.lng,
      p.speed_kmh,
      p.accuracy_m,
      p.heading_deg,
      p.remaining_m,
      p.eta_s,
      p.other_eta_s,
      p.delta_t_s,
      p.cloud_age_s,
      p.session_id
    ].map(csvEscape).join(","));
  }
  const blob=new Blob(["\uFEFF"+lines.join("\n")],{type:"text/csv;charset=utf-8"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download=`MergeNavi_${sessionId()}_${role()}_${new Date().toISOString().replaceAll(":","-")}.csv`;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

function buildRouteFromLogData(logData){
  if(!Array.isArray(logData) || logData.length<2)return [];
  const accepted=[];
  let prev=null;
  for(const p of logData){
    if(!Number.isFinite(p.lat)||!Number.isFinite(p.lng))continue;
    if(Number.isFinite(p.accuracy_m) && p.accuracy_m>30)continue;
    const cur={lat:p.lat,lng:p.lng};
    if(!prev){
      accepted.push(cur); prev=cur; continue;
    }
    const d=haversine(prev,cur);
    if(d<2)continue;
    if(d>80)continue; // obvious GNSS jump for this PoC
    accepted.push(cur);
    prev=cur;
  }
  return accepted;
}
function buildRouteFromLog(){
  if(driveLog.length<2){alert("経路生成には2点以上のログが必要です");return []}
  return buildRouteFromLogData(driveLog);
}

async function saveLogToSupabase(){
  if(!driveLog.length){alert("保存するログがありません");return}
  const nameRaw=$("logName")?.value?.trim() || "";
  const payload={
    log_name:nameRaw || makeDefaultLogName(),
    session_id:sessionId(),
    role:role(),
    point_count:driveLog.length,
    started_at:new Date(driveLog[0].timestamp).toISOString(),
    ended_at:new Date(driveLog[driveLog.length-1].timestamp).toISOString(),
    log_data:driveLog,
    app_version:APP_VERSION
  };
  const {error}=await supabase.from("drive_logs").insert(payload);
  if(error){
    console.error(error);
    alert("クラウド保存の初期設定が未完了です。\n\nログ→自車経路生成にはSQL設定は不要です。\nクラウド保存を使う場合だけ、同梱の supabase_setup.sql をSupabaseのSQL Editorで一度実行してください。\n\n"+error.message);
    return;
  }

  toast(`走行ログ「${payload.log_name}」を保存しました`);
}

function formatCloudLogLabel(row){
  const d=new Date(row.started_at || row.created_at);
  const dateText=Number.isNaN(d.getTime()) ? "日時不明" : d.toLocaleString("ja-JP");
  const roleText=row.role==="main"?"本線":"合流";
  const name=(row.log_name || "").trim();
  return name
    ? `${name}｜${dateText} / ${roleText} / ${row.point_count ?? "?"}点`
    : `${dateText} / ${roleText} / ${row.point_count ?? "?"}点 / ${row.session_id ?? "-"}`;
}

function clearCloudLogList(){
  cloudLogs=[];
  const select=$("cloudLogSelect");
  if(select){
    select.innerHTML='<option value="">「保存ログ取得」を押してください</option>';
  }
  const info=$("cloudLogInfo");
  if(info)info.textContent="現在選択中の車両と同じ種別の保存ログを、最新30件まで表示します。";
}

async function loadCloudLogs(){
  const r=role();
  const select=$("cloudLogSelect");
  const info=$("cloudLogInfo");
  if(select)select.innerHTML='<option value="">取得中...</option>';

  const {data,error}=await supabase
    .from("drive_logs")
    .select("id,created_at,log_name,session_id,role,point_count,started_at,ended_at,app_version,log_data")
    .eq("role",r)
    .order("created_at",{ascending:false})
    .limit(30);

  if(error){
    console.error(error);
    if(select)select.innerHTML='<option value="">取得エラー</option>';
    if(info)info.textContent=`保存ログ取得エラー: ${error.message}`;
    alert("保存済みログを取得できませんでした。\nSELECT権限/RLS Policyを確認してください。\n\n"+error.message);
    return;
  }

  cloudLogs=Array.isArray(data)?data:[];
  if(!cloudLogs.length){
    if(select)select.innerHTML='<option value="">保存ログなし</option>';
    if(info)info.textContent=`${r==="main"?"本線車":"合流車"}の保存ログはまだありません。`;
    return;
  }

  if(select){
    select.innerHTML='<option value="">保存ログを選択...</option>';
    for(const row of cloudLogs){
      const opt=document.createElement("option");
      opt.value=String(row.id);
      opt.textContent=formatCloudLogLabel(row);
      select.appendChild(opt);
    }
  }
  if(info)info.textContent=`${r==="main"?"本線車":"合流車"}の保存ログ ${cloudLogs.length}件を取得しました。`;
  toast(`保存ログ ${cloudLogs.length}件`);
}

async function applySelectedCloudLogAsRoute(){
  const select=$("cloudLogSelect");
  const id=select?.value;
  if(!id){alert("保存ログを選択してください");return}

  const row=cloudLogs.find(x=>String(x.id)===String(id));
  if(!row){alert("選択ログが見つかりません。再取得してください");return}

  const pts=buildRouteFromLogData(row.log_data);
  if(pts.length<2){
    alert("このログから有効な経路を生成できませんでした");
    return;
  }

  const r=role();
  setRoute(r,pts,false);
  await sendBroadcast("route",{role:r,points:pts,sentAt:Date.now()});

  if(routeLayers[r]){
    try{map.fitBounds(routeLayers[r].getBounds(),{padding:[20,20]});}catch{}
  }

  const info=$("cloudLogInfo");
  if(info)info.textContent=`選択ログを自車経路へ設定: ${pts.length}点 / ${formatCloudLogLabel(row)}`;
  toast(`保存ログ→自車経路: ${pts.length}点`);
}

$("autoLogNameBtn").onclick=()=>{
  $("logName").value=makeDefaultLogName();
};
$("logStartBtn").onclick=()=>{
  if(!$("logName").value.trim())$("logName").value=makeDefaultLogName();
  driveLog=[];
  logRecording=true;
  logStartedAt=Date.now();
  lastLogAccepted=null;
  updateLogUi();
  toast("ログ記録開始");
};

$("logStopBtn").onclick=()=>{
  logRecording=false;
  updateLogUi();
  toast(`ログ停止: ${driveLog.length}点`);
};

$("logClearBtn").onclick=()=>{
  if(logRecording){alert("記録中はクリアできません");return}
  driveLog=[];
  logStartedAt=null;
  lastLogAccepted=null;
  updateLogUi();
};

$("logCsvBtn").onclick=downloadCsv;
$("logSaveBtn").onclick=saveLogToSupabase;
$("cloudLogRefreshBtn").onclick=loadCloudLogs;
$("cloudLogRouteBtn").onclick=applySelectedCloudLogAsRoute;
$("cloudLogSelect").onchange=()=>{
  const id=$("cloudLogSelect").value;
  const row=cloudLogs.find(x=>String(x.id)===String(id));
  if(row)$("cloudLogInfo").textContent=formatCloudLogLabel(row);
};

$("logRouteBtn").onclick=async()=>{
  const pts=buildRouteFromLog();
  if(pts.length<2){alert("有効な経路点が2点未満です");return}
  const r=role();
  setRoute(r,pts,false);
  await sendBroadcast("route",{role:r,points:pts,sentAt:Date.now()});
  toast(`端末内ログから経路生成: ${pts.length}点（SQL不要）`);
};
updateLogUi();


$("wakeLockBtn").onclick=async()=>{
  if(wakeLockWanted){
    await releaseWakeLock();
    toast("画面ロック防止 OFF");
  }else{
    wakeLockWanted=true;
    await requestWakeLock();
    if(wakeLockSentinel)toast("画面ロック防止 ON");
  }
};

document.addEventListener("visibilitychange",async()=>{
  if(document.visibilityState==="visible" && wakeLockWanted && !wakeLockSentinel){
    await requestWakeLock();
  }
});

$("gpsBtn").onclick=()=>{if(watchId!=null){navigator.geolocation.clearWatch(watchId);watchId=null;$("gpsBtn").textContent="GPS開始";$("gpsStatus").textContent="停止中";return}if(!navigator.geolocation)return alert("このブラウザは位置情報非対応");
$("gpsSource").textContent="Device Geolocation / High Accuracy";
watchId=navigator.geolocation.watchPosition(
  onGeo,
  e=>$("gpsStatus").textContent=`GPSエラー: ${e.message}`,
  {enableHighAccuracy:true,maximumAge:0,timeout:10000}
);
$("gpsBtn").textContent="GPS停止";
$("gpsStatus").textContent="測位待ち"};
function haversine(a,b){const R=6371000,toRad=x=>x*Math.PI/180,dLat=toRad(b.lat-a.lat),dLng=toRad(b.lng-a.lng),la1=toRad(a.lat),la2=toRad(b.lat);const h=Math.sin(dLat/2)**2+Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2;return 2*R*Math.asin(Math.sqrt(h))}
function deriveSpeed(pos,ts){if(!lastGeo){lastGeo={pos,ts};return null}const dt=(ts-lastGeo.ts)/1000;if(dt<=.2)return null;const v=haversine(lastGeo.pos,pos)/dt;lastGeo={pos,ts};return v}
async function onGeo(g){
  const pos={lat:g.coords.latitude,lng:g.coords.longitude},ts=g.timestamp||Date.now();
  lastGpsTimestamp=ts;

  // Raw優先: 位置はDevice Geolocation値をそのまま使用。
  // 速度も端末が返したcoords.speedをそのまま使い、独自算出・平滑化をしない。
  let sp=(Number.isFinite(g.coords.speed)&&g.coords.speed>=0)?g.coords.speed:null;
  speedEMA=sp;
  currentPos=pos;if(!currentMarker)currentMarker=L.circleMarker([pos.lat,pos.lng],{radius:8,weight:3}).addTo(map);else currentMarker.setLatLng([pos.lat,pos.lng]);const r=role();
  const calcSpeed=getEffectiveSpeed(r,speedEMA);
  const calc=calcForRole(r,pos,calcSpeed);$("gpsStatus").textContent=`${pos.lat.toFixed(6)}, ${pos.lng.toFixed(6)}`;$("accuracy").textContent=Number.isFinite(g.coords.accuracy)?`${g.coords.accuracy.toFixed(1)} m`:"-- m";$("speed").textContent=Number.isFinite(calcSpeed)?`${(calcSpeed*3.6).toFixed(1)} km/h`:"-- km/h";$("remaining").textContent=Number.isFinite(calc.remaining)?`${calc.remaining.toFixed(1)} m`:"-- m";const data={lat:pos.lat,lng:pos.lng,speed:Number.isFinite(calcSpeed)?calcSpeed:null,accuracy:g.coords.accuracy??null,heading:g.coords.heading??null,timestamp:ts,clientSentAt:Date.now(),remaining:calc.remaining,eta:calc.eta};if(logRecording){
  const otherRole=r==="main"?"merge":"main";
  const otherEta=Number.isFinite(telemetry[otherRole]?.eta)?telemetry[otherRole].eta:null;
  const delta=(r==="main")
    ? (Number.isFinite(data.eta)&&Number.isFinite(otherEta)?data.eta-otherEta:null)
    : (Number.isFinite(otherEta)&&Number.isFinite(data.eta)?otherEta-data.eta:null);

  driveLog.push({
    timestamp:ts,
    iso_time:new Date(ts).toISOString(),
    role:r,
    lat:pos.lat,
    lng:pos.lng,
    speed_kmh:Number.isFinite(data.speed)?data.speed*3.6:null,
    accuracy_m:Number.isFinite(g.coords.accuracy)?g.coords.accuracy:null,
    heading_deg:Number.isFinite(g.coords.heading)?g.coords.heading:null,
    remaining_m:Number.isFinite(data.remaining)?data.remaining:null,
    eta_s:Number.isFinite(data.eta)?data.eta:null,
    other_eta_s:Number.isFinite(otherEta)?otherEta:null,
    delta_t_s:Number.isFinite(delta)?delta:null,
    cloud_age_s:lastCloudRx?((Date.now()-lastCloudRx)/1000):null,
    session_id:sessionId()
  });
  updateLogUi();
}
telemetry[r]=data;await sendBroadcast("telemetry",{role:r,data});refreshDashboard()}
$("centerBtn").onclick=()=>{if(currentPos)map.setView([currentPos.lat,currentPos.lng],18)};

function toXY(p,refLat){const R=6371000,rad=Math.PI/180;return{x:R*(p.lng*rad)*Math.cos(refLat*rad),y:R*(p.lat*rad)}}
function projectPointToRoute(p,route){if(!route||route.length<2)return null;const refLat=p.lat,P=toXY(p,refLat);let cum=0,best=null;for(let i=0;i<route.length-1;i++){const A=toXY(route[i],refLat),B=toXY(route[i+1],refLat),vx=B.x-A.x,vy=B.y-A.y,wx=P.x-A.x,wy=P.y-A.y,len2=vx*vx+vy*vy,t=len2?Math.max(0,Math.min(1,(wx*vx+wy*vy)/len2)):0,qx=A.x+t*vx,qy=A.y+t*vy,dx=P.x-qx,dy=P.y-qy,d2=dx*dx+dy*dy,segLen=Math.sqrt(len2);if(!best||d2<best.d2)best={d2,s:cum+t*segLen};cum+=segLen}return{...best,total:cum}}
function getTestValues(r){
  const speedKmh=r==="main"?parseFloat($("testMainSpeed").value):parseFloat($("testMergeSpeed").value);
  const remaining=r==="main"?parseFloat($("testMainRemaining").value):parseFloat($("testMergeRemaining").value);
  const speed=Number.isFinite(speedKmh)?speedKmh/3.6:null;
  return{
    speed,
    remaining:Number.isFinite(remaining)?Math.max(0,remaining):null
  };
}
function getEffectiveSpeed(r,deviceSpeed){
  if($("testMode").checked) return getTestValues(r).speed;
  return Number.isFinite(deviceSpeed)?deviceSpeed:null;
}
function calcForRole(r,pos,sp){
  if($("testMode").checked){
    const t=getTestValues(r);
    const eta=Number.isFinite(t.speed)&&t.speed>0.01&&Number.isFinite(t.remaining)?t.remaining/t.speed:null;
    return{remaining:t.remaining,eta};
  }
  const rt=routes[r];
  if(!mergePoint||!rt||rt.length<2||!pos)return{remaining:null,eta:null};
  const cur=projectPointToRoute(pos,rt),mer=projectPointToRoute(mergePoint,rt);
  if(!cur||!mer)return{remaining:null,eta:null};
  const remaining=Math.max(0,mer.s-cur.s);
  const eta=Number.isFinite(sp)&&sp>.8?remaining/sp:null;
  return{remaining,eta};
}

async function publishIndoorTest(){
  if(!$("testMode").checked) return;
  const now=Date.now();
  for(const r of ["main","merge"]){
    const t=getTestValues(r);
    const eta=Number.isFinite(t.speed)&&t.speed>0.01&&Number.isFinite(t.remaining)?t.remaining/t.speed:null;
    const data={
      lat:null,lng:null,
      speed:t.speed,
      accuracy:null,heading:null,
      timestamp:now,
      clientSentAt:now,
      remaining:t.remaining,
      eta,
      testMode:true
    };
    telemetry[r]=data;
    await sendBroadcast("telemetry",{role:r,data});
  }
  $("gpsSource").textContent="Indoor Test / GPS bypass for ETA";
  const own=getTestValues(role());
  $("speed").textContent=Number.isFinite(own.speed)?`${(own.speed*3.6).toFixed(1)} km/h`:"-- km/h";
  $("remaining").textContent=Number.isFinite(own.remaining)?`${own.remaining.toFixed(1)} m`:"-- m";
  refreshDashboard();
}
function renderVehicle(r,data){
  const e=$(r+"Eta"),d=$(r+"Detail");
  if(!data){e.textContent="--.- s";d.textContent="待機中";return}
  e.textContent=Number.isFinite(data.eta)?`${data.eta.toFixed(1)} s`:"--.- s";
  const kmh=Number.isFinite(data.speed)?data.speed*3.6:null;
  const age=Number.isFinite(data.clientSentAt)?(Date.now()-data.clientSentAt)/1000:null;
  d.innerHTML=`${kmh!=null?kmh.toFixed(1)+" km/h":"-- km/h"} / ${Number.isFinite(data.remaining)?data.remaining.toFixed(0)+" m":"-- m"}${data.testMode?'<span class="testTag">TEST</span>':(age!=null?" / "+age.toFixed(1)+"s old":"")}`;
}
function refreshDashboard(){const m=telemetry.main,g=telemetry.merge;renderVehicle("main",m);renderVehicle("merge",g);const inst=$("instruction"),d=$("delta"),tol=Math.max(.1,parseFloat($("tolerance").value)||.5),control=$("controlRole").value;if(!m||!g||!Number.isFinite(m.eta)||!Number.isFinite(g.eta)){inst.textContent="WAIT";inst.className="instructionText neutral";d.textContent="ΔT --.- s";return}const delta=m.eta-g.eta;d.textContent=`ΔT 本線-合流 = ${delta>=0?"+":""}${delta.toFixed(2)} s`;if(Math.abs(delta)<=tol){inst.textContent="KEEP";inst.className="instructionText ok";return}if(control==="main"){if(delta<0){inst.textContent="本線車 SLOW";inst.className="instructionText slow"}else{inst.textContent="本線車 FAST";inst.className="instructionText fast"}}else{if(delta<0){inst.textContent="合流車 FAST";inst.className="instructionText fast"}else{inst.textContent="合流車 SLOW";inst.className="instructionText slow"}}}
$("tolerance").oninput=async()=>{refreshDashboard();if(isMaster())await publishCommonSettings();};
$("controlRole").onchange=async()=>{refreshDashboard();if(isMaster())await publishCommonSettings();};
$("testMode").onchange=async()=>{
  if(!isMaster())return;
  await publishCommonSettings();
  if($("testMode").checked){
    toast("室内テストON");
    await publishIndoorTest();
  }else{
    toast("実GPSモード");
    $("gpsSource").textContent="Device Geolocation / High Accuracy";
    telemetry.main=null;
    telemetry.merge=null;
    refreshDashboard();
    await sendState();
  }
};
for(const id of ["testMainSpeed","testMainRemaining","testMergeSpeed","testMergeRemaining"]){
  $(id).oninput=async()=>{
    if(!isMaster())return;
    await publishCommonSettings();
    if($("testMode").checked)await publishIndoorTest();
  };
}
setInterval(()=>{$("cloudAge").textContent=lastCloudRx?`${((Date.now()-lastCloudRx)/1000).toFixed(1)} s`:"-- s";$("age").textContent=lastGpsTimestamp?`${Math.max(0,(Date.now()-lastGpsTimestamp)/1000).toFixed(2)} s`:"-- s";refreshDashboard();if(logRecording)updateLogUi()},500);
